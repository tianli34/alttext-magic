import re
import argparse
import sys
from pathlib import Path

def sanitize_filename(name):
    """清理文件名中的非法字符，并去掉前后空格"""
    name = name.strip()
    name = re.sub(r'[\\/*?:"<>|]', "_", name)
    name = name.strip()  # 替换后再次去除可能出现的首尾空格
    return name

def split_markdown(input_file, output_dir=None, keep_h3=False):
    input_path = Path(input_file).resolve()
    if not input_path.exists():
        print(f"错误: 找不到文件 '{input_path}'")
        sys.exit(1)

    if output_dir:
        base_out_dir = Path(output_dir).resolve()
    else:
        base_out_dir = input_path.parent

    master_folder_name = sanitize_filename(input_path.stem)  # 也对主文件夹名做清理
    master_dir = base_out_dir / master_folder_name

    # ========== 第一遍：扫描结构，记录哪些 (h1, h2) 组合下存在 h3 ==========
    h2_has_h3 = set()
    current_h1 = "未分类"
    current_h2 = "通用"

    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.startswith("# "):
                current_h1 = line[2:].strip()
                current_h2 = "通用"
            elif line.startswith("## "):
                current_h2 = line[3:].strip()
            elif line.startswith("### "):
                h2_has_h3.add((current_h1, current_h2))

    # ========== 第二遍：实际分割并写入文件 ==========
    current_h1 = "未分类"
    current_h2 = "通用"
    current_h3 = "概述"
    buffer = []
    written_files = set()

    def build_path():
        """根据当前状态构建输出文件路径"""
        has_h3 = (current_h1, current_h2) in h2_has_h3

        dir_path = master_dir

        if current_h1 != "未分类":
            dir_path = dir_path / sanitize_filename(current_h1)

        if has_h3:
            if current_h2 != "通用":
                dir_path = dir_path / sanitize_filename(current_h2)
            file_path = dir_path / f"{sanitize_filename(current_h3)}.md"
        else:
            if current_h2 != "通用":
                file_path = dir_path / f"{sanitize_filename(current_h2)}.md"
            else:
                file_path = dir_path / f"{sanitize_filename(current_h3)}.md"

        return dir_path, file_path

    def save_current_buffer():
        if any(line.strip() for line in buffer):
            dir_path, file_path = build_path()
            dir_path.mkdir(parents=True, exist_ok=True)

            mode = 'a' if file_path in written_files else 'w'
            with open(file_path, mode, encoding='utf-8') as f:
                f.write("".join(buffer))
            written_files.add(file_path)

        buffer.clear()

    with open(input_path, 'r', encoding='utf-8') as f:
        for line in f:
            if line.startswith("# "):
                save_current_buffer()
                current_h1 = line[2:].strip()
                current_h2 = "通用"
                current_h3 = "概述"

            elif line.startswith("## "):
                save_current_buffer()
                current_h2 = line[3:].strip()
                current_h3 = "概述"

            elif line.startswith("### "):
                save_current_buffer()
                current_h3 = line[4:].strip()
                if keep_h3:
                    buffer.append(line)

            else:
                buffer.append(line)

    save_current_buffer()

    print(f"✅ 处理完成！\n总文件夹已输出至: {master_dir}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="将 Markdown 文档切片为多级文件夹结构。")
    parser.add_argument("filename", help="要处理的 Markdown 文件路径")
    parser.add_argument("-o", "--output", help="自定义输出路径（默认输出到原文档所在目录）", default=None)
    parser.add_argument("--keep-h3", help="在切片文件的正文中保留三级标题", action="store_true")

    args = parser.parse_args()

    split_markdown(args.filename, args.output, args.keep_h3)