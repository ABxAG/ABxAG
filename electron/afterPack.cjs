'use strict';

const fs = require('fs');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const productName = context.packager.appInfo.productFilename;
  const primaryExe = path.join(context.appOutDir, productName + '.exe');
  const runtimeExe = path.join(context.appOutDir, productName + '-runtime.exe');
  const launcherExe = path.join(__dirname, '..', 'build', 'ABxAG-launcher.exe');

  if (!fs.existsSync(primaryExe)) throw new Error('Packaged Electron runtime is missing: ' + primaryExe);
  if (!fs.existsSync(launcherExe)) throw new Error('ABxAG launcher is missing: ' + launcherExe);

  await fs.promises.copyFile(primaryExe, runtimeExe);
  await fs.promises.copyFile(launcherExe, primaryExe);

  // The runtime copy keeps stock Electron version info ("Electron" product
  // name and icon), which is what Task Manager and the taskbar fall back to.
  // Re-stamp it as ABxAG so every surface — Task Manager, taskbar, Alt+Tab,
  // volume mixer, firewall prompts — shows ABxAG with the real icon.
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const version = String(rootPkg.version || '1.0.0');
  const version4 = version.split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
  const iconIco = path.join(__dirname, '..', 'build', 'icon.ico');
  if (!fs.existsSync(iconIco)) throw new Error('Application icon is missing: ' + iconIco);

  let rcedit;
  try {
    ({ rcedit } = require('rcedit'));
    if (typeof rcedit !== 'function') throw new Error('unexpected export shape');
  } catch {
    throw new Error('rcedit devDependency is missing — run `npm install` and rebuild.');
  }
  console.log(`[afterPack] stamping ${path.basename(runtimeExe)} as ABxAG ${version}`);
  await rcedit(runtimeExe, {
    'file-version': version4,
    'product-version': version4,
    'version-string': {
      CompanyName: 'ABxAG',
      FileDescription: 'ABxAG',
      ProductName: 'ABxAG',
      LegalCopyright: 'Copyright © 2026 ABxAG',
      OriginalFilename: `${productName}-runtime.exe`,
    },
    icon: iconIco,
  });
  console.log('[afterPack] runtime exe stamped.');

  // Lightweight installer: Chromium ships ~55 locale paks (~49MB) but the
  // app UI is English-only (Chromium falls back to en-US; spellcheck
  // dictionaries live elsewhere). Drop everything except en-US.
  const localesDir = path.join(context.appOutDir, 'locales');
  try {
    const entries = await fs.promises.readdir(localesDir);
    let kept = 0;
    let freed = 0;
    for (const entry of entries) {
      if (entry.toLowerCase() === 'en-us.pak') {
        kept += 1;
        continue;
      }
      const full = path.join(localesDir, entry);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.isFile()) {
          freed += stat.size;
          await fs.promises.unlink(full);
        }
      } catch {
        /* keep going — a leftover locale never breaks the build */
      }
    }
    console.log(`[afterPack] locales pruned: kept ${kept}, freed ${(freed / 1048576).toFixed(1)}MB.`);
  } catch {
    console.warn('[afterPack] locales dir missing, skipping prune.');
  }

  // koffi ships ~17 platform binaries (~26MB) but the loader
  // (koffi/index.js determine_triplet) opens only build/koffi/<triplet>
  // for the running platform. This x64 Windows pack keeps win32_x64.
  const koffiDir = path.join(context.appOutDir, 'resources', 'app', 'node_modules', 'koffi', 'build', 'koffi');
  try {
    const entries = await fs.promises.readdir(koffiDir);
    let freedKoffi = 0;
    for (const entry of entries) {
      if (entry === 'win32_x64') continue;
      const full = path.join(koffiDir, entry);
      try {
        const stat = await fs.promises.stat(full);
        if (stat.isDirectory()) {
          const files = await fs.promises.readdir(full);
          for (const file of files) {
            const fp = path.join(full, file);
            try {
              freedKoffi += (await fs.promises.stat(fp)).size;
              await fs.promises.unlink(fp);
            } catch {}
          }
          await fs.promises.rmdir(full);
        }
      } catch {
        /* keep going */
      }
    }
    console.log(`[afterPack] koffi triplets pruned: freed ${(freedKoffi / 1048576).toFixed(1)}MB.`);
  } catch {
    console.warn('[afterPack] koffi dir missing, skipping triplet prune.');
  }
};
