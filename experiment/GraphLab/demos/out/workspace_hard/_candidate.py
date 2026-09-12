import math

def is_prime(n: int) -> bool:
    """
    判断一个整数是否为素数（质数）。
    
    参数:
        n: 待判断的整数
        
    返回:
        bool: 如果 n 是素数返回 True，否则返回 False
        
    示例:
        >>> is_prime(2)
        True
        >>> is_prime(4)
        False
        >>> is_prime(17)
        True
    """
    if n <= 1:
        return False
    if n <= 3:
        return True
    if n % 2 == 0 or n % 3 == 0:
        return False
    
    i = 5
    while i * i <= n:
        if n % i == 0 or n % (i + 2) == 0:
            return False
        i += 6
    
    return True


if __name__ == "__main__":
    test_cases = [0, 1, 2, 3, 4, 5, 17, 25, 97, 100]
    for num in test_cases:
        print(f"{num} 是素数吗? {is_prime(num)}")