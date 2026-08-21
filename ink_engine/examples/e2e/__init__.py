"""参考宿主生态件包（examples/e2e/）。

评测闭环基线：参考宿主（host.py/recipe.py/graph.py）+ 评测任务集
（tasks/*.json）+ 评测脚本（run.py）。与 tests/live 的关系：
tests/live 验证引擎承诺机制（机制层正确性），本包验证宿主形态
（装配/回合/评测闭环的参考实现，可复制改造成产品宿主）。
"""
