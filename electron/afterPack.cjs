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
};
