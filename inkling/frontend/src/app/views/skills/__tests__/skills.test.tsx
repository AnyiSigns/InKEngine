import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SkillCard } from '../SkillCard';
import { SkillMarket } from '../SkillMarket';
import { validateSkillsMarket, successRate, crystalSourceLabel } from '../backend';
import type { SkillEntry } from '../backend';

const sampleSkill: SkillEntry = {
  id: 'market.skill.test',
  name: 'test_skill',
  kind: 'visual',
  domain: 'default',
  version: 1,
  description: '测试技能',
  fingerprint: 'test.fingerprint',
  source_path: 'test.path',
  model_id: 'seed',
  hit_count: 90,
  fail_count: 10,
  contract_snapshot: [['vision.perceive', '1'], ['data.extract', '1']],
  evidence_snapshot: [
    { src_type: 'vision.perceive', dst_type: 'data.extract', src_contract_version: '1', dst_contract_version: '1', context_domain: 'default', success_count: 90, fail_count: 10 },
  ],
  path: { nodes: {} },
  test_report: {
    skill_name: 'test_skill',
    version: 1,
    skill_kind: 'visual',
    domain: 'default',
    model_id: 'seed',
    success_rate: 0.9,
    hit_count: 90,
    fail_count: 10,
    sample_edges: [],
    generated_at: 0,
    note: '测试',
  },
};

describe('SkillCard', () => {
  it('渲染技能卡基本信息', () => {
    render(<SkillCard skill={sampleSkill} />);
    expect(screen.getByText('test_skill')).toBeInTheDocument();
    expect(screen.getAllByText(/命中 90/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/成功率 90%/).length).toBeGreaterThan(0);
  });

  it('安装按钮触发回调', () => {
    const onInstall = vi.fn();
    render(<SkillCard skill={sampleSkill} onInstall={onInstall} />);
    screen.getByText('安装').click();
    expect(onInstall).toHaveBeenCalledWith('market.skill.test');
  });
});

describe('SkillMarket', () => {
  it('空态渲染', () => {
    render(<SkillMarket data={{ premounted: false, mount_policy: { required: [], note: '' }, skills: [] }} />);
    expect(screen.getByText(/暂无可用技能/)).toBeInTheDocument();
  });

  it('渲染技能列表', () => {
    render(<SkillMarket data={{ premounted: false, mount_policy: { required: [], note: '' }, skills: [sampleSkill] }} />);
    expect(screen.getByText('test_skill')).toBeInTheDocument();
  });
});

describe('validateSkillsMarket', () => {
  it('有效数据通过校验', () => {
    const result = validateSkillsMarket({
      premounted: false,
      mount_policy: { required: ['vetting'], note: 'test' },
      skills: [{ id: 's1', name: 'test', kind: 'visual', description: 'd', hit_count: 1, fail_count: 0 }],
    });
    expect(result.ok).toBe(true);
  });

  it('缺失字段被捕获', () => {
    const result = validateSkillsMarket({ premounted: 'not_bool' });
    expect(result.ok).toBe(false);
  });
});

describe('successRate', () => {
  it('计算成功率', () => {
    expect(successRate(sampleSkill)).toBe(90);
  });
});

describe('crystalSourceLabel', () => {
  it('生成结晶来源标注', () => {
    const label = crystalSourceLabel(sampleSkill);
    expect(label).toContain('自动结晶');
    expect(label).toContain('90');
    expect(label).toContain('90%');
  });
});
