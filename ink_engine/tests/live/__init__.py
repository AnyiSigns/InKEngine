"""live 套件包标记：防止 tests/live/conftest.py 遮蔽 tests/conftest.py
（单元测试以 `from conftest import ...` 直连根 conftest；无本文件时
tests/live 被当作独立根目录插入 sys.path，`import conftest` 解析到
live 版导致全量回归收集失败）。"""
