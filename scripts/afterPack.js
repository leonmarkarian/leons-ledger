// When building on Linux/macOS (no Wine), stamp the Windows exe with the icon and version info using pure JS.
// On Windows (e.g. GitHub Actions) electron-builder does this itself, so we skip.
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (process.platform === 'win32' || context.electronPlatformName !== 'win32') return;
  const ResEdit = await import('resedit');
  const { NtExecutable, NtExecutableResource, Data, Resource } = ResEdit.default || ResEdit;
  const exeName = `${context.packager.appInfo.productFilename}.exe`;
  const exePath = path.join(context.appOutDir, exeName);
  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);
  const iconFile = Data.IconFile.from(fs.readFileSync(path.join(__dirname, '..', 'build', 'icon.ico')));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups.length ? groups[0].id : 1;
  const lang = groups.length ? groups[0].lang : 1033;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));
  const info = Resource.VersionInfo.fromEntries(res.entries)[0] || Resource.VersionInfo.createEmpty();
  const v = context.packager.appInfo.version.split('.').map(Number);
  info.setFileVersion(v[0], v[1], v[2], 0, 1033);
  info.setProductVersion(v[0], v[1], v[2], 0, 1033);
  info.setStringValues({ lang: 1033, codepage: 1200 }, {
    ProductName: context.packager.appInfo.productName,
    FileDescription: context.packager.appInfo.productName,
    CompanyName: 'Leon Markarian',
    LegalCopyright: '© 2026 Leon Markarian',
    OriginalFilename: exeName
  });
  info.outputToResourceEntries(res.entries);
  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log('  • afterPack: icon and version info written to', exeName);
};
