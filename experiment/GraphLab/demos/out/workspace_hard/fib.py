```python
def fib(n: int) -> int:
    """
    返回第 n 个斐波那契数
    
    参数:
        n: 非负整数，表示斐波那契数列的索引
        
    返回:
        第 n 个斐波那契数（fib(0)=0, fib(1)=1）
        
    异常:
        ValueError: 当 n 为负数时抛出
    """
    if n < 0:
        raise ValueError("n 必须是非负整数")
    
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a
```