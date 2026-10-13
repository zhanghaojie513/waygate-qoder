#!/usr/bin/env node
/**
 * waygate-qoder —— Qoder CN 本地反代（命令 `qoc`）。
 *
 * 读取本机 Qoder 客户端的登录态，在本机提供一个 Anthropic/OpenAI 兼容的聊天端点，
 * 供 Cursor / Claude Code / Cherry Studio 等客户端使用。只在本机读写与转发，不上传任何数据。
 */

import { runCli } from '@waygate/core';
import { createQoderAdapter } from './adapter.js';

const VERSION = '0.1.0';

const code = await runCli(createQoderAdapter(), { version: VERSION });
process.exit(code);
