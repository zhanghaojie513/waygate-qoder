#!/usr/bin/env node
/**
 * waygate-qoder —— Qoder CN 本地反代（命令 `qoc`）。
 *
 * 读取本机 Qoder 客户端的登录态，在本机提供一个 Anthropic/OpenAI 兼容的聊天端点，
 * 供 Cursor / Claude Code / Cherry Studio 等客户端使用。只在本机读写与转发，不上传任何数据。
 */

import { createRequire } from 'node:module';
import { runCli } from 'waygate-core';
import { createQoderAdapter } from './adapter.js';

/* 版本从 package.json 读 —— 硬编码会与 npm 发布版本漂移（已踩过：package 升 0.1.2 而 CLI 仍显示 0.1.0）。 */
const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const code = await runCli(createQoderAdapter(), { version: VERSION });
process.exit(code);
