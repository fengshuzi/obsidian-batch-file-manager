import os
import re
from datetime import date
from collections import defaultdict

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
VAULT_ROOT = os.path.dirname(SCRIPT_DIR)
JOURNALS_DIR = os.path.join(VAULT_ROOT, "journals")
SOURCE_DIR = JOURNALS_DIR
OUTPUT_DIR = JOURNALS_DIR

# 正则匹配 yyyy-mm-dd.md 格式（任意年份）
pattern = re.compile(r'^(\d{4})-(\d{2})-(\d{2})\.md$')
# 与 month_to_daily 一致：解析月文件中的 ## yyyy-mm-dd 段落（支持 - ## 列表项形式）
SECTION_HEADER = re.compile(r"^(?:- )?## (\d{4}-\d{2}-\d{2})\s*$", re.MULTILINE)


def parse_month_content(content):
    """把月文件按 ## 日期 拆成 { date_str: content }，用于幂等合并。"""
    parts = SECTION_HEADER.split(content)
    result = {}
    i = 1
    while i + 1 < len(parts):
        date_str = parts[i].strip()
        result[date_str] = parts[i + 1].strip()
        i += 2
    return result

# 当前年月，不合并当前月份的日文件（保留为日更）
current_ym = date.today().strftime("%Y-%m")

# 按月份聚合：month -> [(date_str, content)], 以及该月要删除的日文件路径
monthly_entries = defaultdict(list)
monthly_deletes = defaultdict(list)

# 遍历所有日文件（跳过当前月份）
for filename in os.listdir(SOURCE_DIR):
    match = pattern.match(filename)
    if not match:
        continue
    year, month, day = match.groups()
    date_str = f"{year}-{month}-{day}"
    year_month = date_str[:7]
    if year_month == current_ym:
        continue
    file_path = os.path.join(SOURCE_DIR, filename)
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            raw = f.read().strip()
            if not raw:
                continue
    except Exception:
        continue
    monthly_entries[year_month].append((date_str, raw))
    monthly_deletes[year_month].append(file_path)

# 幂等合并：先并入已有月文件内容，再写回；只删除本批合并的日文件
for month in sorted(monthly_entries.keys()):
    output_path = os.path.join(OUTPUT_DIR, f"{month}.md")
    # 已有月文件则解析，再与本次日文件合并（同日期以日文件为准）
    existing = {}
    if os.path.exists(output_path):
        try:
            with open(output_path, "r", encoding="utf-8") as f:
                existing = parse_month_content(f.read())
        except Exception:
            pass
    for date_str, content in monthly_entries[month]:
        existing[date_str] = content
    entries = [f"## {d}\n\n{c}\n\n" for d, c in sorted(existing.items())]
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(entries))
    print(f"已写入: {output_path}")
    for path in monthly_deletes[month]:
        os.remove(path)
        print(f"已删除文件: {path}")

print("✅ 合并完成（幂等：多次运行结果一致，已有月文件会与日文件合并后写回）")
