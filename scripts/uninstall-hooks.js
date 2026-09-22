#!/usr/bin/env node
// ~/.claude/settings.json 에서 claude-controller hook 등록을 제거한다. 로직은 src/hooks-install.js.
import { uninstallHooks } from '../src/hooks-install.js';
uninstallHooks();
