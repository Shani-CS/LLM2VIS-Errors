"""Build the static site data for GitHub Pages.

For each test in config.json:
  - reads that test's tab of the error spreadsheet (one row per ID; ID = first column,
    dataset = second column, every other column is a characteristic)
  - loads the results JSON files ({query_id, retries, responses}) and matches each result to
    its spreadsheet row using the source's id_format, e.g. "{query_id}-{retries}" -> "12-0"
  - copies chart images into docs/images/<source id>/ with URL-safe names
Writes docs/data/index.json (tests + filter options) and docs/data/test-<id>.json (records).

Paths in config.json are relative to the folder containing config.json.

Requires openpyxl for .xlsx/.xlsm:  python3 -m pip install openpyxl
Usage:  python3 build_data.py            (uses config.json)
        python3 build_data.py other.json
"""

import csv
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DOCS = ROOT / "docs"
EMPTY = {"", "none", "n/a", "na"}

OPERATION_PATTERNS = {
    "Filtering": r"\.query\(|\.loc\[|\.dropna|\.isin\(",
    "Grouping": r"\.groupby\(",
    "Aggregation": r"\.sum\(|\.mean\(|\.agg\(|\.count\(|\.median\(",
    "Sorting": r"\.sort_values|\.sort_index",
}


def read_sheet(path, sheet):
    """Return (header, rows) with every cell as a stripped string."""
    if path.suffix.lower() == ".csv":
        with open(path, newline="", encoding="utf-8-sig") as f:
            table = list(csv.reader(f))
    else:
        try:
            import openpyxl
        except ImportError:
            sys.exit("Reading Excel files needs openpyxl:  python3 -m pip install openpyxl")
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        table = [["" if v is None else str(v) for v in row] for row in wb[sheet].iter_rows(values_only=True)]
    table = [[c.strip() for c in row] for row in table if any(c.strip() for c in row)]
    header, rows = table[0], table[1:]
    return header, [row + [""] * (len(header) - len(row)) for row in rows if row[0]]


def clean_label(name):
    """'Sorting Error : Ignore ' -> 'Sorting Error: Ignore', 'Self- corrected' -> 'Self-corrected'."""
    name = re.sub(r"\s+", " ", name).strip()
    name = re.sub(r"\s+:", ":", name)
    return re.sub(r"-\s+(?=[a-z])", "-", name)


def normalize_id(value):
    s = str(value).strip()
    return str(int(float(s))) if re.fullmatch(r"-?\d+\.0+", s) else s


def natural_key(s):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def classify_columns(header, cfg):
    """Split spreadsheet columns into prompt / errors / design issues / facets (by index)."""
    hidden = set(cfg.get("hidden", []))
    roles = {"prompt": None, "errors": [], "design": [], "facets": []}
    for i, raw in enumerate(header):
        name = clean_label(raw)
        if i < 2 or not name or name in hidden:
            continue
        if re.search(cfg["prompt"], name, re.I):
            roles["prompt"] = i
        elif re.search(cfg["design_issues"], name, re.I):
            roles["design"].append((i, name))
        elif re.search(cfg["errors"], name, re.I) and not re.search(cfg["error_exclude"], name, re.I):
            roles["errors"].append((i, name))
        else:
            roles["facets"].append((i, name))
    return roles


def load_results(source, base, test_id):
    """Return {sheet ID: responses} for one results file, copying its chart images."""
    results_path = base / source["results"]
    with open(results_path, encoding="utf-8") as f:
        entries = json.load(f)
    images_src = base / source["images_dir"] if source.get("images_dir") else results_path.parent
    images_out = DOCS / "images" / source["id"]
    if images_out.exists():
        shutil.rmtree(images_out)
    images_out.mkdir(parents=True)

    out, missing = {}, 0
    for entry in entries:
        rid = source["id_format"].format(query_id=normalize_id(entry["query_id"]),
                                         retries=entry.get("retries", 0))
        responses = []
        for i, r in enumerate(entry.get("responses", [])):
            kind, content = r.get("type"), r.get("content", "")
            if i == 0 and kind == "text":
                continue  # the first text response is the prompt itself
            if kind == "chart":
                src = images_src / Path(content).name
                if not src.exists():
                    missing += 1
                    responses.append({"type": "chart", "content": None, "missing": Path(content).name})
                    continue
                dest = images_out / re.sub(r"[^A-Za-z0-9._-]", "_", src.name)
                shutil.copy2(src, dest)
                content = f"images/{source['id']}/{dest.name}"
            responses.append({"type": kind, "content": content})
        out[rid] = {"responses": responses,
                    "prompt": next((r["content"] for r in entry.get("responses", []) if r.get("type") == "text"), "")}
    print(f"  source {source['id']}: {len(out)} results, {missing} missing images")
    return out


def build_test(test, config, base):
    tid = test["id"]
    print(f"Test {tid}: {test['name']}")
    header, rows = read_sheet(base / config["spreadsheet"], test["sheet"])
    roles = classify_columns(header, config["columns"])

    results = {}
    for source in test["sources"]:
        results.update(load_results(source, base, tid))

    attempt_re = re.compile(test["attempt_id"]) if test.get("attempt_id") else None
    records = []
    for row in rows:
        rid = normalize_id(row[0])
        res = results.get(rid, {})
        m = attempt_re.match(rid) if attempt_re else None
        code = "\n".join(r["content"] for r in res.get("responses", []) if r["type"] == "code")
        records.append({
            "id": rid,
            "test": tid,
            "dataset": row[1] or "(blank)",
            "prompt": (row[roles["prompt"]] if roles["prompt"] is not None else "") or res.get("prompt", ""),
            "group": m.group("prompt") if m else rid,
            "attempt": int(m.group("attempt")) if m else None,
            "facets": {name: row[i] or "(blank)" for i, name in roles["facets"]},
            "errors": [name for i, name in roles["errors"] if row[i].lower() == "yes"],
            "design": {name: row[i] for i, name in roles["design"] if row[i].lower() not in EMPTY},
            "responses": res.get("responses", []),
            "has_results": bool(res),
            "operations": [op for op, pat in OPERATION_PATTERNS.items() if re.search(pat, code)],
        })

    with open(DOCS / "data" / f"test-{tid}.json", "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, separators=(",", ":"))

    # Filter options: skip characteristics that are blank/N/A for every row of this test.
    facets = []
    for _, name in roles["facets"]:
        values = sorted({r["facets"][name] for r in records}, key=natural_key)
        if any(v.lower() not in EMPTY | {"(blank)"} for v in values):
            facets.append({"name": name, "values": values})
    errors = [name for _, name in roles["errors"] if any(name in r["errors"] for r in records)]
    design = [name for _, name in roles["design"] if any(name in r["design"] for r in records)]

    unmatched_rows = [r["id"] for r in records if not r["has_results"]]
    unmatched_results = sorted(set(results) - {r["id"] for r in records}, key=natural_key)
    print(f"  {len(records)} rows, {len(records) - len(unmatched_rows)} with results; "
          f"{len(facets)} filters, {len(errors)} error types, {len(design)} design issue types")
    if unmatched_rows:
        print(f"  rows without results: {unmatched_rows[:10]}")
    if unmatched_results:
        print(f"  results without a spreadsheet row: {unmatched_results[:10]}")
    return {"id": tid, "name": test["name"], "description": test.get("description", ""),
            "count": len(records), "has_attempts": bool(attempt_re),
            "datasets": sorted({r["dataset"] for r in records}, key=natural_key),
            "facets": facets, "errors": errors, "design": design}


def main():
    config_path = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "config.json"
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
    base = config_path.parent
    (DOCS / "data").mkdir(parents=True, exist_ok=True)
    for old in (DOCS / "data").glob("*.json"):
        old.unlink()
    configured = {s["id"] for t in config["tests"] for s in t["sources"]}
    for old in (DOCS / "images").glob("*"):
        if old.is_dir() and old.name not in configured:
            shutil.rmtree(old)

    tests = [build_test(t, config, base) for t in config["tests"]]
    with open(DOCS / "data" / "index.json", "w", encoding="utf-8") as f:
        json.dump({"title": config.get("title", "LLM Results"), "tests": tests}, f, indent=1)
    print("Done. Preview with:  python3 -m http.server -d docs 8000")


if __name__ == "__main__":
    main()
