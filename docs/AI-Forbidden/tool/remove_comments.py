import re
import sys
from pathlib import Path


def remove_comments_and_blank_lines(source: str) -> str:
    """
    去除 TypeScript / JavaScript 代码中的注释与空行。
    支持：
      - 单行注释  // ...
      - 多行注释  /* ... */  /** ... */
      - 行尾注释  code; // comment
    保留：
      - 字符串内部的 // 或 /* （不误伤）
    """
    result = []
    i = 0
    n = len(source)

    # 用状态机逐字符扫描，正确区分字符串与注释
    current_line_chars = []

    def flush_line():
        """将当前行缓冲写入结果（去除行尾空白）"""
        line = "".join(current_line_chars).rstrip()
        if line:  # 非空行才保留
            result.append(line)
        current_line_chars.clear()

    in_single_quote = False
    in_double_quote = False
    in_template = False  # 模板字符串 `...`

    while i < n:
        ch = source[i]

        # ── 字符串状态处理 ──────────────────────────────────────
        if in_single_quote:
            current_line_chars.append(ch)
            if ch == '\\':          # 转义字符，跳过下一个字符
                i += 1
                if i < n:
                    current_line_chars.append(source[i])
            elif ch == "'":
                in_single_quote = False
            elif ch == '\n':        # 单引号字符串不跨行，强制退出
                in_single_quote = False
                flush_line()
            i += 1
            continue

        if in_double_quote:
            current_line_chars.append(ch)
            if ch == '\\':
                i += 1
                if i < n:
                    current_line_chars.append(source[i])
            elif ch == '"':
                in_double_quote = False
            elif ch == '\n':
                in_double_quote = False
                flush_line()
            i += 1
            continue

        if in_template:
            current_line_chars.append(ch)
            if ch == '\\':
                i += 1
                if i < n:
                    current_line_chars.append(source[i])
            elif ch == '`':
                in_template = False
            elif ch == '\n':        # 模板字符串可以跨行，换行照常输出
                flush_line()
            i += 1
            continue

        # ── 注释状态处理 ────────────────────────────────────────
        # 多行注释 /* ... */
        if ch == '/' and i + 1 < n and source[i + 1] == '*':
            # 跳过直到找到 */
            i += 2
            while i < n:
                if source[i] == '*' and i + 1 < n and source[i + 1] == '/':
                    i += 2
                    break
                if source[i] == '\n':
                    # 多行注释跨行时，把已积累的行内容处理掉
                    # 注释行本身丢弃（flush 不写入，因为 current_line_chars 为空或只有空白）
                    current_line_chars.clear()
                i += 1
            # 注释结束后，如果紧跟换行则让下面正常处理
            continue

        # 单行注释 // ...
        if ch == '/' and i + 1 < n and source[i + 1] == '/':
            # 跳过到行尾（不含换行符，让换行符触发 flush）
            i += 2
            while i < n and source[i] != '\n':
                i += 1
            # 此时 source[i] == '\n' 或到末尾，继续让主循环处理换行
            continue

        # ── 普通字符 ────────────────────────────────────────────
        if ch == '\n':
            flush_line()
            i += 1
            continue

        if ch == "'":
            in_single_quote = True
        elif ch == '"':
            in_double_quote = True
        elif ch == '`':
            in_template = True

        current_line_chars.append(ch)
        i += 1

    # 处理文件末尾没有换行的情况
    flush_line()

    return "\n".join(result) + "\n"


def process_file(input_path: str, output_path: str | None = None) -> None:
    path = Path(input_path)
    if not path.exists():
        print(f"[ERROR] 文件不存在: {input_path}")
        sys.exit(1)

    source = path.read_text(encoding="utf-8")
    cleaned = remove_comments_and_blank_lines(source)

    if output_path:
        Path(output_path).write_text(cleaned, encoding="utf-8")
        print(f"[OK] 已写入: {output_path}")
    else:
        # 默认覆盖原文件（可改为打印到 stdout）
        out = path.with_stem(path.stem + ".cleaned")
        out.write_text(cleaned, encoding="utf-8")
        print(f"[OK] 已写入: {out}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python remove_comments.py <input_file> [output_file]")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2] if len(sys.argv) >= 3 else None
    process_file(input_file, output_file)