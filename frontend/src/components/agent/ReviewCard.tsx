
import { useRef, useState } from 'react';
import { Check, X, Pencil, AlertTriangle, ShieldCheck, FileText, ChevronDown, ChevronUp, ListChecks } from 'lucide-react';
import { cn } from '@/shared/cn';

export type ReviewAction = 'accept' | 'retry' | 'edit' | 'terminate';
export type ReviewType = 'gate' | 'audit' | 'candidate' | 'body';

// 编辑框长度上限（正文/候选共用，单一来源）：与后端
// ReviewActionRequest.edited_content 的 max_length=50000（schema/request/common.py）
// 绑定，任一侧调整必须同步，否则提交 422 或长正文被输入框静默截断。
const REVIEW_EDIT_MAX_LEN = 50000;

interface ReviewCardProps {
  data: Record<string, unknown>;
  onAction: (action: ReviewAction, editedContent?: string, chapterId?: number, candidateId?: string) => void;
  /** 2.12：历史回放只读（true 时不渲染操作按钮，仅展示卡内容） */
  disabled?: boolean;
}

interface CandidateItem {
  node_id: string;
  node_label?: string;
  output?: string;
}

/** 按原因关键词分类展示失败类型（质量/设定/上下文/连贯性/其他）。 */
function reasonCategory(reason: string): { label: string; cls: string } {
  if (/角色|人设|设定/.test(reason)) return { label: '角色/设定不符', cls: 'text-amber-500/90 border-amber-500/30' };
  if (/上下文|背景/.test(reason)) return { label: '上下文缺失', cls: 'text-sky-500/90 border-sky-500/30' };
  if (/连贯|一致|矛盾/.test(reason)) return { label: '连贯性', cls: 'text-violet-500/90 border-violet-500/30' };
  return { label: '质量不达标', cls: 'text-destructive/80 border-destructive/30' };
}

/**
 * 审核卡类型：
 * - gate：写操作门控（update_entity/create_entities 等），展示「确认执行」，非破坏性样式；
 * - audit：质量审计拦截（工作流节点输出 FAIL），展示「输出未通过质量检查」；
 * - candidate：候选选择卡（精品通道多候选），展示候选列表 + 选择/编辑/取消；
 * - body：正文审批卡（正文类写操作/生成通道产物），正文全文 + 确认/编辑/取消。
 * 历史消息无 review_type 时按 reason 启发式回退（门控文案 ≠ 审计 FAIL 文案）。
 */
export function resolveReviewType(data: Record<string, unknown>): ReviewType {
  const rt = data.review_type;
  if (rt === 'gate' || rt === 'audit' || rt === 'candidate' || rt === 'body') return rt;
  const reason = String(data.reason || '');
  return /修改书籍数据|写入长期记忆|确认后才会执行/.test(reason) ? 'gate' : 'audit';
}

/**
 * 反转义后端 json.dumps 产生的预览转义序列（\n、\t、\"、\\ 等），
 * 展示与编辑回填共用：不反转义的话用户会看到字面 \n，且「编辑后提交」
 * 会把转义文本原样写入书籍数据。
 *
 * 必须单遍消费（\\(\\|n|r|t|b|f|") 一次匹配一个转义序列），不能链式多次 replace：
 * 链式会把「字面反斜杠+n」（JSON 中的 \\n，3 字符）拆成 \n 再误翻成换行，
 * 最终丢失反斜杠字面量（如 Windows 路径 a\\nb → 应还原为 a\nb 而非 a+换行+b）。
 * R2：\t/\b/\f（json.dumps 会产出的转义）一并反转义，不再显示字面反斜杠序列。
 */
export function unescapePreview(text: string): string {
  if (!text) return '';
  return text.replace(/\\(\\|n|r|t|b|f|")/g, (_, esc: string) => {
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'b': return '\b';
      case 'f': return '\f';
      case '"': return '"';
      default: return '\\';
    }
  });
}

export function candidateList(data: Record<string, unknown>): CandidateItem[] {
  // 仅候选选择卡解析；其余卡型一律返回空（防脏数据渲染）
  if (data.review_type !== 'candidate') return [];
  const raw = data.candidates;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is CandidateItem =>
      Boolean(c) &&
      typeof c === 'object' &&
      typeof (c as Record<string, unknown>).node_id === 'string',
  );
}

export function ReviewCard({ data, onAction, disabled = false }: ReviewCardProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [showFull, setShowFull] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // 候选卡：正在编辑的候选下标（null=未编辑）
  const [candidateEditing, setCandidateEditing] = useState<number | null>(null);
  const [candidateEditText, setCandidateEditText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const nodeLabel = String(data.node_label || data.node_id || '');
  const reason = String(data.reason || '输出不符合该角色节点的写作要求');
  const reviewType = resolveReviewType(data);
  const isGate = reviewType === 'gate';
  const isAudit = reviewType === 'audit';
  const isCandidate = reviewType === 'candidate';
  const isBody = reviewType === 'body';
  // body 卡编辑回填优先用后端透传的完整正文（content 字段，未截断）；
  // 无该字段（旧后端/滚动窗口）时回退截断预览——此时禁用编辑入口，
  // 防止把「…（已截断）」残缺正文写回章节。gate 卡同样带 content 全量（展开后展示）。
  const summaryPreview = unescapePreview(String(data.output_preview || ''));
  const fullContent = (isBody || isGate) && typeof data.content === 'string' ? data.content : '';
  // 展开文本：有全量 content 优先展示真全量（彻底全量）；否则用后端预览
  const expandText = fullContent ? unescapePreview(fullContent) : summaryPreview;
  // 折叠文本：body 沿用「正文前 300 字」，gate/其余用后端摘要预览前 300 字
  const collapsedText = (isBody && fullContent ? fullContent : summaryPreview).slice(0, 300);
  // 是否展示「查看完整输出」：全量文本超出 300 字，或折叠摘要与全量内容不一致（被略掉的条目）
  const canExpand = expandText.length > 300 || (fullContent !== '' && expandText !== collapsedText);
  const canEditFull = !isBody || Boolean(fullContent);
  // 后端审计拦截卡携带目标章节；「终止并生成正文」需回传定位落库章节
  const targetChapterId = typeof data.target_id === 'number' ? data.target_id : undefined;
  // 卡片展示节点 tokens 与耗时（后端 pending_review 附带；gate/body/candidate 卡
  // 恒为 0，仅在真实存在（>0）时渲染，避免无意义的「0t · 0.0s」）
  const tokens = typeof data.tokens === 'number' ? data.tokens : undefined;
  const elapsedMs = typeof data.elapsed_ms === 'number' ? data.elapsed_ms : undefined;
  const hasMetrics = (tokens !== undefined && tokens > 0) || (elapsedMs !== undefined && elapsedMs > 0);
  const category = reasonCategory(reason);
  const candidates = isCandidate ? candidateList(data) : [];

  const handleAction = (action: ReviewAction, editedContent?: string, candidateId?: string) => {
    if (submitting || disabled) return;
    if (action === 'edit' && !(editedContent || '').trim()) {
      // 空内容校验：不提交，聚焦输入框
      textareaRef.current?.focus();
      return;
    }
    setSubmitting(true);
    onAction(action, editedContent, targetChapterId, candidateId);
  };

  const startEditing = () => {
    // 写工具审核卡的 output_preview 以「章节ID=xxx」开头，那是预览前缀而非正文，
    // 回填编辑框前剥离，避免提交修改时把前缀写进章节正文。
    //
    // 注意：此处与后端 gating_service 的预览格式耦合（backend 侧 _strip_preview_prefix
    // 用同一规则做落库前的防御性清洗）。结构化的章节 id 走 data.target_chapter_id 回传，
    // 不依赖该前缀解析；即便后端将来去掉前缀，这里也只是「无匹配、原样回填」，不会出错。
    // 容忍 CRLF 换行，仅剥离首行前缀。
    setEditText(fullContent.replace(/^章节ID=\d+\r?\n/, ''));
    setEditing(true);
  };

  const startCandidateEdit = (index: number) => {
    const c = candidates[index];
    setCandidateEditing(index);
    setCandidateEditText(unescapePreview(String(c?.output || '')));
  };

  const accent = isGate ? 'amber' : isCandidate ? 'sky' : isBody ? 'emerald' : 'destructive';

  const headerIcon = isGate ? <ShieldCheck size={14} className="text-amber-500 shrink-0" />
    : isCandidate ? <ListChecks size={14} className="text-sky-500 shrink-0" />
    : isBody ? <FileText size={14} className="text-emerald-500 shrink-0" />
    : <AlertTriangle size={14} className="text-destructive shrink-0" />;

  const headerTitle = isGate ? '操作确认'
    : isCandidate ? '候选选择'
    : isBody ? '正文审批'
    : '审核请求';

  const headerCls = isGate ? 'text-amber-600/90 dark:text-amber-400/90'
    : isCandidate ? 'text-sky-600/90 dark:text-sky-400/90'
    : isBody ? 'text-emerald-600/90 dark:text-emerald-400/90'
    : 'text-destructive';

  const descText = isGate
    ? <>节点 &ldquo;{nodeLabel}&rdquo; 请求执行一次{reason.includes('长期记忆') ? '记忆写入' : '书籍数据修改'}</>
    : isCandidate
    ? data.source === 'divergent'
      ? <>平行起草完成，{candidates.length} 个版本，请选择其一作为本章正文（内容不进对话上下文，仅展示）</>
      : <>工作流执行完成，{candidates.length} 个候选正文节点，请选择其一作为本章正文（内容不进对话上下文，仅展示）</>
    : isBody
    ? <>节点 &ldquo;{nodeLabel}&rdquo; 产出正文，请确认后落库</>
    : <>节点 &ldquo;{nodeLabel}&rdquo; 的输出未通过质量检查</>;

  return (
    // 间距统一：不再带 mx/my 额外边距，与其它消息/状态卡一致使用消息流 10px 间距；
    // 圆角与状态卡统一为 rounded-md
    <div className={cn('p-3 rounded-md border', accent === 'amber' && 'border-amber-500/40 bg-amber-500/[0.04]', accent === 'sky' && 'border-sky-500/40 bg-sky-500/[0.04]', accent === 'emerald' && 'border-emerald-500/40 bg-emerald-500/[0.04]', accent === 'destructive' && 'border-destructive/40 bg-destructive/5')}>
      <div className="flex items-center gap-2 mb-2">
        {headerIcon}
        <span className={cn('text-xs font-semibold', headerCls)}>
          {headerTitle}
        </span>
        {(hasMetrics) && (
          <span className="text-[10px] text-muted-foreground/60 tabular-nums">
            {tokens !== undefined && tokens > 0 && `${tokens}t`}
            {tokens !== undefined && tokens > 0 && elapsedMs !== undefined && elapsedMs > 0 && ' · '}
            {elapsedMs !== undefined && elapsedMs > 0 && `${(elapsedMs / 1000).toFixed(1)}s`}
          </span>
        )}
        {isAudit && <span className={cn('ml-auto text-[10px] px-1.5 py-px rounded-full border', category.cls)}>{category.label}</span>}
      </div>
      <div className={cn('text-xs mb-1', isGate || isCandidate || isBody ? 'text-foreground/70' : 'text-muted-foreground')}>
        {descText}
      </div>

      {/* T7 写时预检冲突详情：命中冲突（同名实体/回收不匹配/状态回退）时展示，
          用户据此裁决（通过仍落库/修改/终止） */}
      {Array.isArray(data.conflicts) && data.conflicts.length > 0 && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/[0.04] p-2 space-y-1">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-destructive">
            <AlertTriangle size={12} />
            写时预检冲突（{data.conflicts.length} 项）
          </div>
          {data.conflicts.slice(0, 5).map((c, i) => (
            <div key={i} className="text-[11px] leading-relaxed text-foreground/80">
              <span className="text-destructive/80">
                {c.severity === 'error' ? '冲突' : '提示'}
              </span>
              ：{String(c.message || '')}
            </div>
          ))}
          {data.conflicts.length > 5 && (
            <div className="text-[10px] text-muted-foreground/60">…（其余 {data.conflicts.length - 5} 项略）</div>
          )}
        </div>
      )}

      {isCandidate ? (
        // 候选选择卡：全量文本按候选顺序划分，操作=选择/编辑/取消（候选正文不进对话上下文）
        <div className="space-y-2 mb-2">
          {candidates.length === 0 && (
            <div className="text-[11px] text-muted-foreground/60 border border-dashed border-border rounded-md p-2">
              候选数据缺失（无 candidates 字段）
            </div>
          )}
          {candidates.map((c, i) => {
            const output = unescapePreview(String(c.output || ''));
            const label = String(c.node_label || c.node_id || '');
            const isEditingThis = candidateEditing === i;
            return (
              <div key={c.node_id || i} className="rounded-md border border-border/40 bg-background/60 overflow-hidden">
                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border/30 bg-muted/30">
                  <span className="text-[11px] font-semibold text-foreground/80 truncate">{label}</span>
                  <span className="text-[10px] text-muted-foreground/50 font-mono">{c.node_id}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground/50 tabular-nums">{output.length} 字</span>
                </div>
                {isEditingThis ? (
                  <div className="p-2 space-y-2">
                    <textarea
                      value={candidateEditText}
                      maxLength={REVIEW_EDIT_MAX_LEN}
                      onChange={(e) => setCandidateEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') { e.preventDefault(); setCandidateEditing(null); }
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleAction('edit', candidateEditText, c.node_id); }
                      }}
                      className="w-full h-32 rounded-md text-xs p-2 bg-background border border-border resize-none focus:outline-none"
                    />
                    <div className="flex gap-2 justify-end">
                      <button onClick={() => handleAction('edit', candidateEditText, c.node_id)} disabled={!candidateEditText.trim() || submitting}
                        className="px-3 h-6 rounded-md bg-foreground text-background text-[11px] font-medium border-none cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
                        {submitting ? '提交中…' : '提交修改'}
                      </button>
                      <button onClick={() => setCandidateEditing(null)} disabled={submitting}
                        className="px-3 h-6 rounded-md border border-border text-[11px] cursor-pointer bg-transparent hover:bg-muted disabled:opacity-40 disabled:cursor-default">
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-2">
                    <div className="text-[11px] text-foreground/80 whitespace-pre-wrap border-l-2 pl-2 border-sky-500/30 max-h-52 overflow-y-auto">
                      {output}
                    </div>
                    <div className="flex gap-2 mt-2">
                      <button onClick={() => handleAction('accept', undefined, c.node_id)} disabled={submitting}
                        className="flex-1 h-6 rounded-md bg-foreground text-background text-[11px] font-medium border-none cursor-pointer flex items-center justify-center gap-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
                        <Check size={11} /> {submitting ? '处理中…' : '选用'}
                      </button>
                      <button onClick={() => startCandidateEdit(i)} disabled={submitting}
                        className="flex-1 h-6 rounded-md border border-border text-[11px] cursor-pointer bg-transparent hover:bg-muted disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1">
                        <Pencil size={11} /> 编辑
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className={cn('text-[11px] mb-2 whitespace-pre-wrap border-l-2 pl-2', isGate ? 'text-foreground/80 border-amber-500/30' : isBody ? 'text-foreground/80 border-emerald-500/30' : 'text-foreground/80 border-destructive/30')}>
          {showFull ? (
            <div className="max-h-52 overflow-y-auto">{expandText}</div>
          ) : (
            <>
              {collapsedText}
              {canExpand && '...'}
            </>
          )}
          {canExpand && (
            <button
              onClick={() => setShowFull((v) => !v)}
              className={cn('mt-1 flex items-center gap-1 text-[10px] bg-transparent border-none cursor-pointer px-0', isGate ? 'text-amber-600/80 dark:text-amber-400/80' : isBody ? 'text-emerald-600/80 dark:text-emerald-400/80' : 'text-destructive/80')}
            >
              {showFull ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
              {showFull ? '收起' : '查看完整输出'}
            </button>
          )}
        </div>
      )}

      {!isCandidate && <div className={cn('text-[11px] mb-2 italic', isGate || isBody ? 'text-muted-foreground/80' : 'text-muted-foreground')}>{reason}</div>}

      {disabled ? (
        <div className="text-[10px] text-muted-foreground/50 border-t border-border/30 pt-1.5">
          历史审核记录（只读）
        </div>
      ) : isCandidate ? (
        // 候选选择卡底部：仅取消（终止整个确认流程，重新生成走对话指令）
        <div className="space-y-1.5">
          <button onClick={() => handleAction('terminate')} disabled={submitting}
            className="w-full h-7 rounded-md border border-destructive/40 bg-transparent text-muted-foreground text-xs cursor-pointer hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1">
            <X size={12} /> 取消选择
          </button>
        </div>
      ) : isGate ? (
        // 门禁卡 = 纯权限审批（设计 L230）：只有 接受/拒绝，无编辑采纳、
        // 无拒绝重试、无「终止并生成正文」（R4：与门控确认语义对齐）。
        <div className="flex gap-2">
          <button onClick={() => handleAction('accept')} disabled={submitting}
            className="flex-1 h-7 rounded-md bg-foreground text-background text-xs font-medium border-none cursor-pointer flex items-center justify-center gap-1 hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
            <Check size={12} /> {submitting ? '处理中…' : '确认执行'}
          </button>
          <button onClick={() => handleAction('terminate')} disabled={submitting}
            className="flex-1 h-7 rounded-md border border-destructive/40 text-destructive text-xs cursor-pointer bg-transparent hover:bg-destructive/10 disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1">
            <X size={12} /> 拒绝
          </button>
        </div>
      ) : editing ? (
        <div className="space-y-2">
          <textarea
            ref={textareaRef}
            value={editText}
            maxLength={REVIEW_EDIT_MAX_LEN}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              // Esc 取消，Ctrl/Cmd+Enter 提交（快捷键）
              if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleAction('edit', editText); }
            }}
            placeholder={collapsedText}
            className="w-full h-20 rounded-md text-xs p-2 bg-background border border-border resize-none focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground/60 tabular-nums">{editText.length}/{REVIEW_EDIT_MAX_LEN}</span>
            <div className="flex gap-2">
            <button onClick={() => handleAction('edit', editText)} disabled={!editText.trim() || submitting}
              className="flex-1 h-7 rounded-md bg-foreground text-background text-xs font-medium border-none cursor-pointer hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
              {submitting ? '提交中…' : '提交修改'}
            </button>
            <button onClick={() => setEditing(false)} disabled={submitting}
              className="px-3 h-7 rounded-md border border-border text-xs cursor-pointer bg-transparent hover:bg-muted disabled:opacity-40 disabled:cursor-default">
              取消
            </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <button onClick={() => handleAction('accept')} disabled={submitting}
              className={cn(
                'flex-1 h-7 rounded-md text-xs font-medium border-none cursor-pointer flex items-center justify-center gap-1',
                'bg-foreground text-background hover:opacity-90 disabled:opacity-40 disabled:cursor-default',
              )}
            >
              <Check size={12} /> {submitting ? '处理中…' : isBody ? '确认' : '接受'}
            </button>
            {!isBody && (
              <button onClick={() => handleAction('retry')} disabled={submitting}
                className="flex-1 h-7 rounded-md bg-destructive/10 text-destructive text-xs font-medium border-none cursor-pointer hover:bg-destructive/20 disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1"
              >
                <X size={12} /> 拒绝重试
              </button>
            )}
            <button onClick={startEditing} disabled={submitting || !canEditFull}
              title={isBody && !canEditFull ? '当前卡不包含完整正文，编辑会丢失截断部分' : undefined}
              className="flex-1 h-7 rounded-md border border-border text-xs cursor-pointer bg-transparent hover:bg-muted disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1"
            >
              <Pencil size={12} /> {isBody ? '编辑' : '自定义'}
            </button>
          </div>
          {!isBody && (
            <button onClick={() => handleAction('terminate')} disabled={submitting}
              className="w-full h-7 rounded-md border border-destructive/40 bg-transparent text-muted-foreground text-xs cursor-pointer hover:bg-destructive/10 hover:text-destructive disabled:opacity-40 disabled:cursor-default flex items-center justify-center gap-1"
            >
              <FileText size={12} /> 终止并生成正文
            </button>
          )}
        </div>
      )}
    </div>
  );
}
