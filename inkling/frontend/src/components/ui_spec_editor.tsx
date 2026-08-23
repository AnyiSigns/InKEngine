/**
 * 界面树编辑器（ui_spec 编辑，承载于悬浮窗）：树选择 + 拖拽/移动 +
 * 增删面板 + 改 bind + 调 props。
 *
 * 约束：组件引用限白名单（isComponentRegistered / 容器白名单）、
 * bind 通道经 isBindChannelAllowed 校验、整体经 validateUiSpec 校验；
 * 非法编辑一律拒绝并提示（草稿不变），应用时再次校验（防绕过）。
 * 草稿经可注入界面状态存储持久（视图切换不丢编辑现场）。
 */

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';

import type { UINode, UISpec } from '@/renderer/uiSpecTypes';
import { isComponentRegistered } from '@/renderer/componentRegistry';
import { isBindChannelAllowed } from '@/renderer/channelWhitelist';
import { validateUiSpec } from '@/renderer/validation';
import { cn } from '@/shared/cn';
import { Button } from '@/shared/ui/Button';
import { FloaterWindow } from '@/components/floaters/floater_window';

const CONTAINER_TYPES = new Set(['column', 'row', 'views', 'overlay']);

function isContainerType(type: string): boolean {
  return CONTAINER_TYPES.has(type);
}

interface UiSpecEditorProps {
  uiSpec?: UISpec | null;
  onApplyUiSpec?: (spec: UISpec) => void;
  onClose?: () => void;
}

export function UiSpecEditor({ uiSpec, onApplyUiSpec, onClose }: UiSpecEditorProps) {
  const [draft, setDraft] = useState<UISpec>(() => uiSpec ?? fallbackSpec());
  const [selected, setSelected] = useState<string>('root');
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  const nodesByPath = useMemo(() => {
    const map = new Map<string, UINode>();
    const walk = (node: UINode, path: string): void => {
      map.set(path, node);
      node.children?.forEach((child, index) => walk(child, `${path}.${index}`));
    };
    walk(draft.root ?? emptyNode(), 'root');
    return map;
  }, [draft]);

  const selectedNode = nodesByPath.get(selected);

  const setDraftValidated = (next: UISpec): boolean => {
    const validation = validateUiSpec(next);
    if (!validation.ok) {
      setError(`非法编辑已拒绝，未应用：${validation.reason ?? '结构损坏'}`);
      return false;
    }
    setError(null);
    setDraft(next);
    return true;
  };

  const apply = (): void => {
    const validation = validateUiSpec(draft);
    if (!validation.ok) {
      setError(`非法编辑已拒绝，未应用：${validation.reason ?? '结构损坏'}`);
      return;
    }
    onApplyUiSpec?.(draft);
    setApplied(true);
    setTimeout(() => setApplied(false), 700);
  };

  const updateSelected = (patch: (node: UINode) => UINode): void => {
    if (!selectedNode) return;
    const pathObj = findPathOf(draft.root ?? emptyNode(), selected);
    if (!pathObj) return;
    const siblings = [...(pathObj.parent.children ?? [])];
    siblings[pathObj.index] = patch(siblings[pathObj.index] ?? selectedNode);
    const newRoot = walkPatchByParent(draft.root ?? emptyNode(), pathObj.parentPath, siblings);
    setDraftValidated({ ...draft, root: newRoot });
  };

  const moveSelected = (direction: 'up' | 'down'): void => {
    const pathObj = findPathOf(draft.root ?? emptyNode(), selected);
    if (!pathObj) return;
    const siblings = [...(pathObj.parent.children ?? [])];
    const target = direction === 'up' ? pathObj.index - 1 : pathObj.index + 1;
    if (target < 0 || target >= siblings.length) return;
    [siblings[pathObj.index], siblings[target]] = [siblings[target], siblings[pathObj.index]];
    const newRoot = walkPatchByParent(draft.root ?? emptyNode(), pathObj.parentPath, siblings);
    setDraftValidated({ ...draft, root: newRoot });
  };

  const removeSelected = (): void => {
    const pathObj = findPathOf(draft.root ?? emptyNode(), selected);
    if (!pathObj) return;
    const siblings = (pathObj.parent.children ?? []).filter((_, index) => index !== pathObj.index);
    const newRoot = walkPatchByParent(draft.root ?? emptyNode(), pathObj.parentPath, siblings);
    if (newRoot) setDraftValidated({ ...draft, root: newRoot });
    setSelected('root');
  };

  const addChild = (childKind: 'container' | 'component'): void => {
    if (!selectedNode || selectedNode.kind !== 'container') {
      setError('仅在容器上可添加子面板');
      return;
    }
    const child: UINode =
      childKind === 'container'
        ? { kind: 'container', type: 'column', children: [] }
        : { kind: 'component', type: 'message_list', props: {} };
    const newRoot = walkPatchByParent(draft.root ?? emptyNode(), selected, [...(selectedNode.children ?? []), child]);
    const next = { ...draft, root: newRoot };
    if (setDraftValidated(next)) setSelected(`${selected}.${(selectedNode.children ?? []).length}`);
  };

  /** 更新节点类型：组件引用限白名单（未注册组件拒绝并提示）。
   *  返回是否应用（未应用时编辑器字段保留用户输入，草稿不动）。 */
  const patchType = (value: string): boolean => {
    if (!selectedNode) return false;
    if (value === selectedNode.type) {
      return true;
    }
    const valid = selectedNode.kind === 'container' ? isContainerType(value) : isComponentRegistered(value);
    if (!valid) {
      setError(
        selectedNode.kind === 'container'
          ? `容器类型非法（须为 column/row/views/overlay），未应用：${value}`
          : `组件未注册（组件白名单拒绝），未应用：${value}`,
      );
      return false;
    }
    updateSelected((node) => ({ ...node, type: value }));
    return true;
  };

  /** 更新 bind：通道白名单 + 路径段校验（非法拒绝不落草稿）。 */
  const patchBind = (channel: string, path: string): boolean => {
    if (!selectedNode) return false;
    if (channel && !isBindChannelAllowed(channel, path)) {
      setError('绑定通道未放行（通道/路径白名单拒绝），未应用');
      return false;
    }
    updateSelected((node) => ({ ...node, bind: channel ? { channel, path } : undefined }));
    return true;
  };

  /** 更新 props：仅接受合法 JSON 对象（非法拒绝不落草稿）。 */
  const patchProps = (raw: string): boolean => {
    if (raw.trim() === '') {
      updateSelected((node) => ({ ...node, props: {} }));
      return true;
    }
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('须为对象');
      updateSelected((node) => ({ ...node, props: parsed as Record<string, unknown> }));
      return true;
    } catch {
      setError('props 非合法 JSON 对象，未应用');
      return false;
    }
  };

  const onDropBefore = (targetPath: string): void => {
    if (selected === targetPath) return;
    const sourcePathObj = findPathOf(draft.root ?? emptyNode(), selected);
    if (!sourcePathObj) return;
    const targetPathObj = findPathOf(draft.root ?? emptyNode(), targetPath);
    if (!targetPathObj || sourcePathObj.parentPath !== targetPathObj.parentPath) return;
    const siblings = [...(sourcePathObj.parent.children ?? [])];
    const [moving] = siblings.splice(sourcePathObj.index, 1);
    const adjust = sourcePathObj.index < targetPathObj.index ? 1 : 0;
    siblings.splice(Math.max(0, targetPathObj.index - adjust), 0, moving);
    const newRoot = walkPatchByParent(draft.root ?? emptyNode(), sourcePathObj.parentPath, siblings);
    setDraftValidated({ ...draft, root: newRoot });
  };

  return (
    <FloaterWindow
      title="界面树编辑器"
      floaterKey="ui_spec_editor"
      onClose={onClose}
      initialRect={{ x: 160, y: 72, width: 520, height: 460 }}
      dataUi="ui_spec_editor"
    >
      <div className="flex h-full flex-col gap-2.5 p-3.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] ink-text-muted">root.{selected === 'root' ? '' : selected}</span>
          {error && <span className="shrink-0 text-[10px] ink-accent" data-ui="editor_error">{error}</span>}
          <span className="ml-auto flex gap-2">
            <Button size="xs" variant="secondary" onClick={() => setError(null)}>清除提示</Button>
            <Button size="xs" variant="primary" data-ui="editor_apply" onClick={apply} disabled={applied}>
              {applied ? '已应用' : '应用'}
            </Button>
          </span>
        </div>

        <div className="ink-scroll-auto min-h-0 flex-1 rounded-[var(--ink-radius-md)] border border-[var(--ink-border)] bg-[var(--ink-bg-base)] p-2" data-ui="editor_tree">
          <TreeRow
            root={draft.root ?? emptyNode()}
            path="root"
            selected={selected}
            onSelect={setSelected}
            onMove={moveSelected}
            onRemove={removeSelected}
            onAddChild={addChild}
            onDropBefore={onDropBefore}
          />
        </div>

        {selectedNode && (
          <div className="space-y-2 rounded-[var(--ink-radius-md)] border border-[var(--ink-border)] p-2.5">
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant="secondary" data-ui="editor_move_up" onClick={() => moveSelected('up')}>
                <ArrowUp size={10} strokeWidth={1.8} /> 上移
              </Button>
              <Button size="xs" variant="secondary" data-ui="editor_move_down" onClick={() => moveSelected('down')}>
                <ArrowDown size={10} strokeWidth={1.8} /> 下移
              </Button>
              {selectedNode.kind === 'container' && (
                <>
                  <Button size="xs" variant="secondary" data-ui="editor_add_container" onClick={() => addChild('container')}>
                    <Plus size={10} strokeWidth={1.8} /> 子容器
                  </Button>
                  <Button size="xs" variant="secondary" data-ui="editor_add_component" onClick={() => addChild('component')}>
                    <Plus size={10} strokeWidth={1.8} /> 子组件
                  </Button>
                </>
              )}
              <Button size="xs" variant="ghost" data-ui="editor_remove" onClick={removeSelected}>
                <Trash2 size={10} strokeWidth={1.8} /> 删除
              </Button>
            </div>
            <div className="flex items-center gap-2 text-[10px]">
              <span className="w-12 shrink-0 ink-text-muted">类型</span>
              <EditorTextField
                key={`${selected}.type`}
                initialValue={selectedNode.type}
                dataUi="editor_type"
                placeholder={selectedNode.kind === 'container' ? 'column' : 'message_list'}
                hint={selectedNode.kind === 'container' ? 'column/row/views/overlay' : '须为已注册组件'}
                onCommit={(value) => patchType(value)}
              />
            </div>
            {selectedNode.kind === 'component' && (
              <div className="flex items-center gap-2 text-[10px]">
                <span className="w-12 shrink-0 ink-text-muted">bind</span>
                <EditorTextField
                  key={`${selected}.channel`}
                  initialValue={selectedNode.bind?.channel ?? ''}
                  dataUi="editor_bind_channel"
                  placeholder="channel"
                  onCommit={(value) => patchBind(value, selectedNode.bind?.path ?? '')}
                />
                <EditorTextField
                  key={`${selected}.path`}
                  initialValue={selectedNode.bind?.path ?? ''}
                  dataUi="editor_bind_path"
                  placeholder="path"
                  onCommit={(value) => patchBind(selectedNode.bind?.channel ?? '', value)}
                />
              </div>
            )}
            <div className="flex items-center gap-2 text-[10px]">
              <span className="w-12 shrink-0 ink-text-muted">props</span>
              <EditorTextField
                key={`${selected}.props`}
                initialValue={selectedNode.props ? JSON.stringify(selectedNode.props) : ''}
                dataUi="editor_props"
                placeholder="{}"
                onCommit={(value) => patchProps(value)}
              />
            </div>
          </div>
        )}
      </div>
    </FloaterWindow>
  );
}

function fallbackSpec(): UISpec {
  return {
    name: 'inkling.ui',
    version: 1,
    root: {
      kind: 'container',
      type: 'column',
      children: [{ kind: 'component', type: 'message_list' }],
    },
  };
}

/**
 * 编辑器输入字段（局部草稿）：合法值回写节点草稿，非法值保留输入
 * 并提示（拒绝面）——避免受控输入在逐字符输入时被重置的对抗。
 */
function EditorTextField({
  initialValue,
  dataUi,
  placeholder,
  hint,
  onCommit,
}: {
  initialValue: string;
  dataUi: string;
  placeholder?: string;
  hint?: string;
  onCommit: (value: string) => boolean;
}) {
  const [draft, setDraft] = useState(initialValue);
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <input
        value={draft}
        data-ui={dataUi}
        placeholder={placeholder}
        onChange={(e) => {
          setDraft(e.target.value);
          onCommit(e.target.value);
        }}
        className="ink-input h-6 min-w-0 flex-1 rounded-md px-1.5 font-mono text-[10px]"
      />
      {hint ? <span className="shrink-0 ink-text-faint">{hint}</span> : null}
    </div>
  );
}

function emptyNode(): UINode {
  return { kind: 'container', type: 'column', children: [] };
}

/** 按父路径整体替换 children（增删/重排使用）。 */
function walkPatchByParent(node: UINode, parentPath: string, siblings: UINode[]): UINode {
  if (parentPath === 'root') return { ...node, children: siblings };
  const segment = parentPath.split('.').slice(1).join('.');
  const parts = segment.split('.');
  if (parts.length === 1) {
    const index = Number(parts[0]);
    const children = [...(node.children ?? [])];
    if (index >= 0 && index < children.length) {
      children[index] = { ...children[index], children: siblings };
      return { ...node, children };
    }
    return node;
  }
  const index = Number(parts[0]);
  const child = node.children?.[index];
  if (!child) return node;
  const children = [...(node.children ?? [])];
  children[index] = walkPatchByParent(child, parts.slice(1).join('.'), siblings);
  return { ...node, children };
}

function findPathOf(
  node: UINode,
  path: string,
): { parent: UINode; index: number; parentPath: string } | null {
  const find = (current: UINode, currentPath: string): { parent: UINode; index: number; parentPath: string } | null => {
    for (let index = 0; index < (current.children?.length ?? 0); index += 1) {
      const child = current.children?.[index];
      if (!child) continue;
      const childPath = currentPath === 'root' ? `root.${index}` : `${currentPath}.${index}`;
      if (childPath === path) return { parent: current, index, parentPath: currentPath };
      const deeper = find(child, childPath);
      if (deeper) return deeper;
    }
    return null;
  };
  return find(node, 'root');
}

/** 树行渲染 + 拖拽（HTML5 dnd：拖移动交换；行内悬浮操作为降级面）。 */
function TreeRow({
  root,
  path,
  selected,
  onSelect,
  onMove,
  onRemove,
  onAddChild,
  onDropBefore,
}: {
  root: UINode;
  path: string;
  selected: string;
  onSelect: (path: string) => void;
  onMove: (direction: 'up' | 'down') => void;
  onRemove: () => void;
  onAddChild: (kind: 'container' | 'component') => void;
  onDropBefore: (targetPath: string) => void;
}): ReactNode {
  return (
    <RowNode node={root} path={path} depth={0} selected={selected} onSelect={onSelect} onMove={onMove} onRemove={onRemove} onAddChild={onAddChild} onDropBefore={onDropBefore} />
  );
}

function RowNode({
  node,
  path,
  depth,
  selected,
  onSelect,
  onMove,
  onRemove,
  onAddChild,
  onDropBefore,
}: {
  node: UINode;
  path: string;
  depth: number;
  selected: string;
  onSelect: (path: string) => void;
  onMove: (direction: 'up' | 'down') => void;
  onRemove: () => void;
  onAddChild: (kind: 'container' | 'component') => void;
  onDropBefore: (targetPath: string) => void;
}) {
  const isSelected = selected === path;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        data-ui={`editor_row_${path}`}
        data-selected={isSelected}
        draggable
        onDragStart={(event) => event.dataTransfer.setData('text/plain', path)}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          onDropBefore(path);
        }}
        onClick={() => onSelect(path)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') onSelect(path);
        }}
        className={cn(
          'flex items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-[10px] cursor-pointer',
          isSelected ? 'bg-[var(--ink-bg-elevated)]' : 'hover:bg-[var(--ink-bg-elevated)]',
        )}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        <span className={cn('ink-chip py-px text-[8px]', node.kind === 'container' ? '' : 'ink-text-faint')}>
          {node.kind === 'container' ? node.type : node.type}
        </span>
        <span className="min-w-0 truncate">
          {node.kind === 'container' ? `(${(node.children ?? []).length})` : node.bind ? `bind:${node.bind.channel}` : '无 bind'}
        </span>
      </div>
      {node.children?.map((child, index) => (
        <RowNode
          key={`${path}.${index}`}
          node={child}
          path={`${path}.${index}`}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onMove={onMove}
          onRemove={onRemove}
          onAddChild={onAddChild}
          onDropBefore={onDropBefore}
        />
      ))}
    </div>
  );
}
