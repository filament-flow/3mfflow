#!/usr/bin/env node
// 3MF Flow – Desktop-Client
// Überwacht einen lokalen Ordner (z.B. den Export-Ordner von Bambu Studio /
// OrcaSlicer / PrusaSlicer) auf neue .3mf-Dateien und lädt sie automatisch
// zu FilamentFlow hoch. Die Datei landet dort in einer Warteschlange - die
// inhaltliche Zuordnung (Filament/Projekt/Platte) macht der User danach
// manuell in der App (ThreeMFImport).
//
// Node.js >= 18 erforderlich (nutzt globales fetch/FormData/Blob).

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const chokidar = require('chokidar');

// ── Pfade: bei pkg-Build liegt die Config neben der .exe, nicht im Snapshot ──
const isPkg = !!process.pkg;
const baseDir = isPkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(baseDir, 'config.json');
const LOG_PATH = path.join(baseDir, '3mfflow.log');

let config = null;

// ── Logging: Konsole + Datei, damit man im Hintergrund laufende Instanzen
// später nachvollziehen kann ──
function log(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + '\n');
  } catch (_) {
    // Logfile-Fehler sollen das Tool nicht crashen
  }
}

// ── Erstkonfiguration per Konsoleneingabe, falls config.json fehlt ──
function ask(rl, question, defaultValue) {
  return new Promise((resolve) => {
    rl.question(`${question}${defaultValue ? ` [${defaultValue}]` : ''}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function runSetupWizard() {
  console.log('\n=== 3MF Flow – Erstkonfiguration ===');
  console.log('Den API-Key findest du in der FilamentFlow App unter Einstellungen -> 3MF Flow.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const apiBaseUrl = await ask(rl, 'FilamentFlow URL', 'https://filament-flow.com');
  const apiKey = await ask(rl, 'API-Key');
  const watchFolder = await ask(rl, 'Ordner, der überwacht werden soll (z.B. dein Slicer-Export-Ordner)');
  rl.close();

  const newConfig = {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ''),
    apiKey,
    watchFolder,
    stabilityWaitMs: 2000,
    maxRetries: 5,
    retryBackoffMs: 5000
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
  console.log(`\nKonfiguration gespeichert unter: ${CONFIG_PATH}`);
  console.log('Du kannst die Werte dort jederzeit per Texteditor anpassen.\n');
  return newConfig;
}

async function loadConfig() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return {
        stabilityWaitMs: 2000,
        maxRetries: 5,
        retryBackoffMs: 5000,
        ...raw
      };
    } catch (err) {
      log('ERROR', `config.json ist beschädigt (${err.message}). Starte Setup neu.`);
      return runSetupWizard();
    }
  }
  return runSetupWizard();
}

// ── Hilfsordner innerhalb des Watch-Folders (werden selbst nicht überwacht) ──
function ensureSubfolders(watchFolder) {
  const uploadedDir = path.join(watchFolder, '_uploaded');
  const failedDir = path.join(watchFolder, '_failed');
  fs.mkdirSync(uploadedDir, { recursive: true });
  fs.mkdirSync(failedDir, { recursive: true });
  return { uploadedDir, failedDir };
}

// ── Wartet, bis sich die Dateigröße nicht mehr ändert (Slicer fertig geschrieben) ──
async function waitUntilStable(filePath, waitMs) {
  let lastSize = -1;
  for (let i = 0; i < 10; i++) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (_) {
      return false; // Datei wurde inzwischen wieder entfernt/umbenannt
    }
    if (stat.size === lastSize && stat.size > 0) {
      return true;
    }
    lastSize = stat.size;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return true; // nach 10 Versuchen trotzdem weitermachen, lieber hochladen als ewig warten
}

// ── Upload einer einzelnen Datei, mit Retry bei Netzwerkfehlern ──
async function uploadFile(filePath, cfg) {
  const fileName = path.basename(filePath);
  const buffer = fs.readFileSync(filePath);

  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([buffer]), fileName);

      const res = await fetch(`${cfg.apiBaseUrl}/api/3mf-flow/upload`, {
        method: 'POST',
        headers: { 'x-3mfflow-api-key': cfg.apiKey },
        body: form
      });

      if (res.status === 401 || res.status === 403) {
        log('ERROR', `Upload abgelehnt (${res.status}) - API-Key ungültig oder widerrufen. ` +
          'Bitte in den FilamentFlow-Einstellungen einen neuen Key erzeugen und in config.json eintragen.');
        return { ok: false, fatal: true };
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body}`);
      }

      log('INFO', `Hochgeladen: ${fileName}`);
      return { ok: true, fatal: false };
    } catch (err) {
      log('WARN', `Upload-Versuch ${attempt}/${cfg.maxRetries} für ${fileName} fehlgeschlagen: ${err.message}`);
      if (attempt < cfg.maxRetries) {
        await new Promise((r) => setTimeout(r, cfg.retryBackoffMs * attempt));
      }
    }
  }
  return { ok: false, fatal: false };
}

// ── Verarbeitung einer einzelnen erkannten Datei ──
const processing = new Set(); // verhindert doppelte Verarbeitung bei schnellen Events

async function handleNewFile(filePath, cfg, dirs) {
  if (processing.has(filePath)) return;
  processing.add(filePath);

  try {
    const fileName = path.basename(filePath);
    log('INFO', `Neue 3MF-Datei erkannt: ${fileName}`);

    const stable = await waitUntilStable(filePath, cfg.stabilityWaitMs);
    if (!stable || !fs.existsSync(filePath)) {
      log('WARN', `${fileName} verschwand vor Upload, übersprungen.`);
      return;
    }

    const result = await uploadFile(filePath, cfg);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (result.ok) {
      const target = path.join(dirs.uploadedDir, `${timestamp}_${fileName}`);
      fs.renameSync(filePath, target);
    } else {
      const target = path.join(dirs.failedDir, `${timestamp}_${fileName}`);
      fs.renameSync(filePath, target);
      fs.writeFileSync(`${target}.error.txt`,
        `Upload fehlgeschlagen am ${new Date().toISOString()}.\n` +
        `Details siehe 3mfflow.log im Programmordner.\n` +
        (result.fatal ? 'Ursache: API-Key ungültig/widerrufen.\n' : 'Ursache: Wiederholt nicht erreichbar.\n'));
      log('ERROR', `${fileName} konnte nicht hochgeladen werden, nach ${dirs.failedDir} verschoben.`);
    }
  } catch (err) {
    log('ERROR', `Unerwarteter Fehler bei ${filePath}: ${err.stack || err.message}`);
  } finally {
    processing.delete(filePath);
  }
}

async function main() {
  config = await loadConfig();

  if (!config.apiKey || !config.watchFolder) {
    log('ERROR', 'Konfiguration unvollständig (apiKey/watchFolder fehlt). Bitte config.json prüfen.');
    process.exit(1);
  }
  if (!fs.existsSync(config.watchFolder)) {
    log('ERROR', `Überwachter Ordner existiert nicht: ${config.watchFolder}`);
    process.exit(1);
  }

  const dirs = ensureSubfolders(config.watchFolder);

  log('INFO', `3MF Flow gestartet.`);
  log('INFO', `Überwache: ${config.watchFolder}`);
  log('INFO', `Ziel: ${config.apiBaseUrl}/api/3mf-flow/upload`);

  const watcher = chokidar.watch(config.watchFolder, {
    ignored: [
      `${dirs.uploadedDir}/**`,
      `${dirs.failedDir}/**`
    ],
    ignoreInitial: false, // bereits vorhandene Dateien beim Start auch hochladen
    depth: 0,              // nur direkt im Ordner, keine Unterordner
    awaitWriteFinish: {    // zusätzliche Stabilitätsprüfung von chokidar selbst
      stabilityThreshold: 1000,
      pollInterval: 200
    }
  });

  watcher.on('add', (filePath) => {
    if (filePath.toLowerCase().endsWith('.3mf')) {
      handleNewFile(filePath, config, dirs);
    }
  });

  watcher.on('error', (err) => {
    log('ERROR', `Watcher-Fehler: ${err.message}`);
  });

  process.on('SIGINT', () => {
    log('INFO', 'Beende 3MF Flow...');
    watcher.close().then(() => process.exit(0));
  });
}

main().catch((err) => {
  log('ERROR', `Fataler Fehler beim Start: ${err.stack || err.message}`);
  process.exit(1);
});
