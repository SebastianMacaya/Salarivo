import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// A fresh headless profile; no attachment to a person's browser or saved sessions.
export async function openBrowser() {
  const executable = [process.env.SALARIVO_TEST_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((path) => path && existsSync(path));
  if (!executable) throw new Error('Set SALARIVO_TEST_BROWSER to a Chrome/Chromium/Edge executable.');
  const profile = await mkdtemp(join(tmpdir(), 'salarivo-browser-'));
  const child = spawn(executable, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-extensions', '--disable-sync', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  let command;
  const pending = new Map();
  const events = new Map();
  let nextId = 0;
  const close = async () => {
    if (socket?.readyState === WebSocket.OPEN && command) {
      try { await Promise.race([command('Browser.close'), delay(3000)]); } catch { /* Browser shutdown can close CDP before acknowledging. */ }
    }
    socket?.close();
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Browser closed.')); }
    pending.clear();
    if (child.exitCode === null) {
      await Promise.race([new Promise((done) => child.once('exit', done)), delay(3000)]);
      if (child.exitCode === null) { child.kill(); await Promise.race([new Promise((done) => child.once('exit', done)), delay(5000)]); }
    }
    const target = resolve(profile);
    if (!target.startsWith(`${resolve(tmpdir())}${sep}salarivo-browser-`)) throw new Error('Refusing cleanup outside the test profile.');
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };
  try {
    let port;
    const started = Date.now();
    while (!port && Date.now() - started < 15000) {
      try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); }
      catch { await delay(100); }
    }
    if (!port) throw new Error('Headless browser did not open CDP.');
    const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    socket = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }); });
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(String(data));
      if (message.id) {
        const request = pending.get(message.id);
        if (!request) return;
        clearTimeout(request.timer); pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else {
        for (const listener of events.get(message.method) || []) listener(message.params);
      }
    });
    command = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async (expression, timeout = 15000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await delay(100); }
      throw new Error(`Condition timed out: ${expression}`);
    };
    const navigate = async (url) => {
      if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw new Error('Browser smoke tests require localhost.');
      let loaded = false;
      const listener = () => { loaded = true; };
      const set = events.get('Page.loadEventFired') || new Set();
      set.add(listener); events.set('Page.loadEventFired', set);
      try {
        await command('Page.navigate', { url });
        const deadline = Date.now() + 20000;
        while (!loaded && Date.now() < deadline) await delay(100);
        if (!loaded) throw new Error('Page did not finish loading.');
      } finally { set.delete(listener); }
    };
    const viewport = async (width, height = 900, mobile = width < 768) => {
      await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      await command('Emulation.setTouchEmulationEnabled', { enabled: mobile });
    };
    const screenshot = async (path) => {
      const { data } = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      await writeFile(path, Buffer.from(data, 'base64'));
    };
    await command('Page.enable');
    await command('Runtime.enable');
    const on = (method, listener) => { const set = events.get(method) || new Set(); set.add(listener); events.set(method, set); return () => set.delete(listener); };
    return { command, evaluate, waitFor, navigate, viewport, screenshot, close, on };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Browser startup and cleanup failed.'); }
    throw error;
  }
}
