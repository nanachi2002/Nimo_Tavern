// Must be the first import of app.js: SillyTavern modules read config.yaml at import time.
import yaml from 'yaml';
import { vfs } from './vfs.js';
import { setConfigFilePath } from '../../src/util.js';
import { SW_CONFIG } from './config.js';

globalThis.DATA_ROOT = '/data';
globalThis.COMMAND_LINE_ARGS = { dataRoot: '/data', enableAccounts: false };
vfs.mkdirSync('/srv/public', { recursive: true });
vfs.mkdirSync('/data/_uploads', { recursive: true });
vfs.writeFileSync('/srv/config.yaml', yaml.stringify(SW_CONFIG));
setConfigFilePath('/srv/config.yaml');
