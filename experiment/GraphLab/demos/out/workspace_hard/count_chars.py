def count_chars(s):
    """
    返回字符串中每个字符出现次数的字典。
    
    参数:
        s (str): 输入字符串
        
    返回:
        dict: 字符到出现次数的映射
    """
    result = {}
    for char in s:
        result[char] = result.get(char, 0) + 1
    return result