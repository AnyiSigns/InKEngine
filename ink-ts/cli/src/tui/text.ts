/**
 * TUI 用户可见文案（controller 状态/编辑器标题/事件行的中文单源）。
 * 独立小文件避免大文件写入编码损坏；将来可平移为 i18n 词典。
 */

export const TXT = {
  noSession: '无会话——到 sessions 视图按 n 新建',
  initFail: '初始化失败',
  createFail: '新建会话失败',
  listApprovalsFail: '读审批队列失败',
  noApprovalCard: '无待审批卡',
  badJson: 'edited_content 非合法 JSON: ',
  busy: '回合运行中，稍后再发',
  createOnSendFail: '无会话且新建失败',
  readMessagesFail: '读消息失败',
  sending: '回合运行中…',
  roundDone: '回合完成',
  sendFail: 'rounds.send 失败',
  sessionOpen: '会话 ',
  resolving: '裁决 ',
  resolved: '已裁决 ',
  failTail: '失败',
  arrow: '⟩',
  approvalArrow: '审批 ',
  rejectTitle: '拒绝 ',
  rejectTail: '（原因，可空直接回车）',
  editTitle: '编辑 ',
  editTail: '（JSON edited_content）',
};
