#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import re
import sys
from pathlib import Path


def sanitize_name(name: str) -> str:
    """清理文件名/文件夹名中的非法字符"""
    name = name.strip()
    name = re.sub(r'[\\/:*?"<>|]', '_', name)
    name = re.sub(r'\s+', ' ', name)
    return name if name else "untitled"


def unique_path(path: Path) -> Path:
    """若文件已存在，则自动追加序号"""
    if not path.exists():
        return path

    parent = path.parent
    stem = path.stem
    suffix = path.suffix
    index = 1

    while True:
        candidate = parent / f"{stem}_{index}{suffix}"
        if not candidate.exists():
            return candidate
        index += 1


def normalize_content(lines):
    """整理正文内容，去掉首尾多余空白，但保留中间换行"""
    text = "\n".join(lines).strip()
    return text + "\n" if text else ""


def parse_markdown(md_text: str):
    """
    解析 Markdown，输出统一结构：

    {
        "root_preamble": str,  # 文档开头、任何标题前的悬空内容
        "h1": [
            {
                "title": str,
                "preamble": str,   # 一级标题下、二级标题前的悬空内容
                "h2": [
                    {
                        "title": str,
                        "preamble": str,  # 二级标题下、三级标题前的悬空内容
                        "h3": [
                            {"title": str, "content": str}
                        ]
                    }
                ]
            }
        ]
    }
    """
    lines = md_text.splitlines()

    data = {
        "root_preamble": "",
        "h1": []
    }

    root_buffer = []

    current_h1 = None
    current_h2 = None
    current_h3 = None
    current_buffer = []

    def flush_h3():
        nonlocal current_h3, current_buffer, current_h2
        if current_h3 is not None and current_h2 is not None:
            current_h2["h3"].append({
                "title": current_h3,
                "content": normalize_content(current_buffer)
            })
        current_h3 = None
        current_buffer = []

    def flush_to_preamble():
        nonlocal current_buffer, current_h1, current_h2, current_h3, root_buffer

        content = current_buffer[:]
        current_buffer = []

        if not content:
            return

        if current_h3 is not None:
            # 正常来说不会走这里，h3 应由 flush_h3 处理
            return

        text = normalize_content(content)

        if current_h2 is not None:
            current_h2["preamble"] += text
        elif current_h1 is not None:
            current_h1["preamble"] += text
        else:
            root_buffer.extend(content)

    for line in lines:
        stripped = line.strip()

        m1 = re.match(r'^#\s+(.+)', stripped)
        m2 = re.match(r'^##\s+(.+)', stripped)
        m3 = re.match(r'^###\s+(.+)', stripped)

        if m1:
            if current_h3 is not None:
                flush_h3()
            else:
                flush_to_preamble()

            current_h2 = None
            current_h3 = None

            current_h1 = {
                "title": sanitize_name(m1.group(1)),
                "preamble": "",
                "h2": []
            }
            data["h1"].append(current_h1)

        elif m2:
            if current_h3 is not None:
                flush_h3()
            else:
                flush_to_preamble()

            if current_h1 is None:
                # 若文档直接从二级标题开始，则自动创建一个默认一级目录
                current_h1 = {
                    "title": "未命名一级标题",
                    "preamble": "",
                    "h2": []
                }
                data["h1"].append(current_h1)

            current_h3 = None
            current_h2 = {
                "title": sanitize_name(m2.group(1)),
                "preamble": "",
                "h3": []
            }
            current_h1["h2"].append(current_h2)

        elif m3:
            if current_h3 is not None:
                flush_h3()
            else:
                flush_to_preamble()

            if current_h1 is None:
                current_h1 = {
                    "title": "未命名一级标题",
                    "preamble": "",
                    "h2": []
                }
                data["h1"].append(current_h1)

            if current_h2 is None:
                current_h2 = {
                    "title": "未命名二级标题",
                    "preamble": "",
                    "h3": []
                }
                current_h1["h2"].append(current_h2)

            current_h3 = sanitize_name(m3.group(1))
            current_buffer = []

        else:
            current_buffer.append(line)

    # 收尾
    if current_h3 is not None:
        flush_h3()
    else:
        flush_to_preamble()

    data["root_preamble"] = normalize_content(root_buffer)
    return data


def write_text_file(path: Path, content: str):
    """写文件；仅当内容非空时写入"""
    if not content.strip():
        return
    path = unique_path(path)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def export_structure(data, output_base: Path, bundle_name: str):
    """
    所有输出统一放入一个总文件夹：
    output_base / bundle_name
    """
    bundle_dir = output_base / sanitize_name(bundle_name)
    bundle_dir.mkdir(parents=True, exist_ok=True)

    # 文档最前面的悬空内容
    write_text_file(bundle_dir / "_index.md", data["root_preamble"])

    for h1 in data["h1"]:
        h1_dir = bundle_dir / sanitize_name(h1["title"])
        h1_dir.mkdir(parents=True, exist_ok=True)

        # 一级标题下、二级标题前的悬空内容
        write_text_file(h1_dir / "_index.md", h1["preamble"])

        for h2 in h1["h2"]:
            h2_dir = h1_dir / sanitize_name(h2["title"])
            h2_dir.mkdir(parents=True, exist_ok=True)

            # 二级标题下、三级标题前的悬空内容
            write_text_file(h2_dir / "_index.md", h2["preamble"])

            for h3 in h2["h3"]:
                file_path = unique_path(h2_dir / f"{sanitize_name(h3['title'])}.md")
                with open(file_path, "w", encoding="utf-8") as f:
                    # 不再在正文中重复写 ### 标题
                    f.write(h3["content"])


def main():
    if len(sys.argv) < 2:
        print("用法: python md_split.py <markdown文件路径> [输出目录]")
        sys.exit(1)

    md_file = Path(sys.argv[1]).resolve()
    if not md_file.exists():
        print(f"错误：文件不存在 -> {md_file}")
        sys.exit(1)

    # 默认输出路径：目标文档所在目录
    output_dir = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else md_file.parent

    with open(md_file, "r", encoding="utf-8") as f:
        md_text = f.read()

    data = parse_markdown(md_text)

    # 总文件夹名默认用源文件名（不含扩展名）
    bundle_name = md_file.stem
    export_structure(data, output_dir, bundle_name)

    print(f"处理完成。")
    print(f"源文件: {md_file}")
    print(f"输出目录: {(output_dir / bundle_name).resolve()}")


if __name__ == "__main__":
    main()