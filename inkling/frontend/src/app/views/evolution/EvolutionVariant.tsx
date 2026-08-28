import type { EvolutionVariant } from './backend';

/** evolution_variant 独立渲染器（renderer=evolution_factory，非 incubator_panel）。 */
export function EvolutionVariant({ item }: { item: EvolutionVariant }) {
  return (
    <div className="w3-panel" data-testid="evolution-variant" data-renderer="evolution_factory">
      <div className="w3-panel-title">{item.label}</div>
      <div className="w3-muted">{item.summary}</div>
    </div>
  );
}
