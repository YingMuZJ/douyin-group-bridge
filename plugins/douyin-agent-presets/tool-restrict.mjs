// Reuse upstream's maintained list to hide inherited local/development tools.
import { RESTRICTED_TOOL_NAMES } from '../qq-agent-presets/qq-tool-restrict.mjs';
export const name = 'douyin-tool-restrict';
export const inject = ['tools'];
export function apply(ctx) {
  for (const name of [...RESTRICTED_TOOL_NAMES, 'ask_user_question', 'todo_write']) {
    try { ctx.tools.restrict({ deny: [name] }); } catch { /* absent on this DSH version */ }
  }
  // Also blocks inherited MCP tools, including old QQ send tools. No tool
  // authorization is delegated to the model or to group message contents.
  ctx.tools.guard(() => '抖音群聊预设仅允许文本对话，工具执行已禁用');
}
