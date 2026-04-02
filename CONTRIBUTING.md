# Contributing Guide

感谢你为 Accio Manager 提交改进。

在提交 issue 或 pull request 之前，请先阅读以下规则，尤其是隐私与敏感数据要求。

## 基本原则

- 保持改动聚焦，不要在同一个 PR 中混入无关修改
- 优先修复明确问题，避免顺手重构大段无关代码
- 提交前确认本地可以正常启动项目
- 所有公开讨论默认以“最少披露”处理敏感信息

## 隐私与敏感信息

本项目会接触本地账号元数据、Cookie、Token、Profile 文件和设备标识。

请不要在以下位置提交真实敏感数据：

- issue 正文
- pull request 描述
- commit message
- 日志输出
- 页面截图
- 录屏

提交前请确认已经移除或脱敏以下内容：

- access token
- refresh token
- cookie
- callback URL 中的敏感参数
- 本地账号 ID、邮箱、手机号
- `data/` 目录导出内容
- `~/.accio` 或 `~/Library/Application Support/Accio` 中的真实路径细节

## 开发流程

1. Fork 或克隆仓库
2. 创建独立分支
3. 安装依赖：`npm install`
4. 本地启动：`npm run dev`
5. 完成修改后自查敏感信息
6. 提交 PR，并简要说明变更目的、影响范围和验证方式

## Issue 提交建议

请尽量提供：

- 问题现象
- 复现步骤
- 预期行为
- 实际行为
- 运行环境

如果问题与认证、账号切换、配额获取或本地 Profile 有关，请只描述现象，不要直接贴原始凭证或完整回调链接。

## Pull Request 要求

- 描述改动目的
- 描述用户可见影响
- 说明是否涉及认证、配额、Profile 或本地数据处理逻辑
- 说明如何验证

如果 PR 中包含 UI 变化，优先提供已脱敏截图，或提供不含真实账号信息的示意图。

## 安全问题

如果你发现安全漏洞，请不要先公开披露。

请参考 [SECURITY.md](./SECURITY.md) 中的说明，通过私下渠道联系维护者。
