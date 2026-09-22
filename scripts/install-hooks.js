#!/usr/bin/env node
// ~/.claude/settings.json 에 claude-controller hook을 등록한다. 로직은 src/hooks-install.js.
import { installHooks } from '../src/hooks-install.js';
installHooks({ copy: process.argv.includes('--copy') ? true : process.argv.includes('--no-copy') ? false : undefined });
