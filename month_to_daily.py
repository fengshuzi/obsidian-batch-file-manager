#!/usr/bin/env python3
"""
月合并文件 → 按日拆分为单文件（一键还原）

与 merge_to_month.py 相反：读取 yyyy-mm.md，按 ## yyyy-mm-dd 拆成多个 yyyy-mm-dd.md。
合并后可用本脚本一键还原为每日独立文件。
"""
import os
import re
import argparse
from typing import Optional

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VAULT_ROOT = os.path.dirname(SCRIPT_DIR)
JOURNALS_DIR = os.path.join(VAULT_ROOT, "journals")

# 匹配段落头：行首的 ## yyyy-mm-dd 或 - ## yyyy-mm-dd（月文件里可能被写成列表项）
SECTION_HEADER = re.compile(r"^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)
# 匹配月文件文件名 yyyy-mm.md
MONTH_FILE = re.compile(r"^(\d{4})-(\d{2})\.md$")


def split_month_to_daily(content: str):
    """按 ## yyyy-mm-dd 切分，返回 [(date_str, content), ...]。"""
    parts = SECTION_HEADER.split(content)
    # parts[0] 可能是空或月文件开头的空/杂项，从 parts[1] 起是 日期、内容、日期、内容...
    result = []
    i = 1
    while i + 1 < len(parts):
        date_str = parts[i].strip()
        block = parts[i + 1]
        # 去掉首尾空行，与 merge_to_month 写回的格式一致
        result.append((date_str, block.strip()))
        i += 2
    return result


def run(delete_month_file: bool = False, journals_dir: Optional[str] = None):
    dir_ = journals_dir or JOURNALS_DIR
    if not os.path.isdir(dir_):
        print(f"❌ 目录不存在: {dir_}")
        return

    month_files = []
    for name in os.listdir(dir_):
        m = MONTH_FILE.match(name)
        if m:
            month_files.append((m.group(1), m.group(2), os.path.join(dir_, name)))

    month_files.sort(key=lambda x: (x[0], x[1]))

    for year, month, path in month_files:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        entries = split_month_to_daily(content)
        if not entries:
            print(f"⚠️ 未找到日期段落，跳过: {path}")
            continue
        for date_str, block in entries:
            if not block.strip():
                continue  # 内容为空不创建文件
            out_path = os.path.join(dir_, f"{date_str}.md")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(block)
            print(f"已还原: {out_path}")
        if delete_month_file:
            os.remove(path)
            print(f"已删除月文件: {path}")

    print("✅ 月 → 日还原完成！")


def main():
    parser = argparse.ArgumentParser(description="将月合并文件拆分为每日文件（一键还原）")
    parser.add_argument(
        "--no-delete-month",
        action="store_true",
        dest="keep_month",
        help="还原后保留月文件（默认会删除 yyyy-mm.md）",
    )
    parser.add_argument(
        "--journals",
        default=None,
        help=f"日记目录路径（默认: {JOURNALS_DIR}）",
    )
    args = parser.parse_args()
    run(delete_month_file=not args.keep_month, journals_dir=args.journals or None)


if __name__ == "__main__":
    main()
