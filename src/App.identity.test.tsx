// @vitest-environment jsdom
/**
 * 验收：含前导/尾随/连续/纯空格以及逗号、引号的合法灯具 id，必须在全部入口保持
 * 逐字节身份：
 *   入口 1：查找框（不修剪首尾空格、不折叠连续空白，查找失败不改变选择/试移/补丁）
 *   入口 2：冲突组按钮
 *   入口 3：试移结果（原位/目标位）列表，并核对实际提交目标
 *   修订复核：复核表格、采纳集合（不用逗号拼接）、下载 JSON 的字节级内容
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { IdText } from "./App";
import { Fixture, compareUtf8, parsePatch } from "./lib/dmx";
import { serializePatch } from "./lib/review";

// 视觉相近但逐字节不同的合法 id（字符集 U+0020–U+007E）
const A = "A";
const LA = " A"; // 前导空格
const AR = "A "; // 尾随空格
const WS = "  "; // 纯空格 id
const A2B = "A  B"; // 连续空格
const AB = "A B"; // 单个空格
const COMMA = "a,b";
const QUOTE = 'a"b';

/**
 * 三组链式冲突，刻意让空格变体分属不同 universe：
 * u1: " A"[10,11] — "A  B"[11,12]
 * u2: "A"[20,21] — "A "[21,22] — "  "[22,23]（端点相接链）
 * u3: "A B"[30,31] — 'a,b'[31,32] — 'a"b'[32,33]（端点相接链）
 */
function identityPatch(): Fixture[] {
  const f = (id: string, universe: number, start: number, footprint = 2): Fixture => ({
    id,
    universe,
    start,
    footprint,
  });
  return [
    f(LA, 1, 10),
    f(A2B, 1, 11),
    f(A, 2, 20),
    f(AR, 2, 21),
    f(WS, 2, 22),
    f(AB, 3, 30),
    f(COMMA, 3, 31),
    f(QUOTE, 3, 32),
  ];
}

/** 以 id 为参数的导入文件输入（jsdom 25 的 File 无 text()，逐例补上）。 */
function patchFile(fixtures: Fixture[], name = "patch.json"): File {
  const json = JSON.stringify(fixtures);
  const file = new File([json], name, { type: "application/json" });
  Object.defineProperty(file, "text", {
    value: () => Promise.resolve(json),
  });
  return file;
}

/**
 * 按 data-id 在容器内找 id 渲染节点。
 * 不用 getByTitle：Testing Library 会把期望值中的连续空白折叠，无法匹配 "A  B"。
 */
function idSpan(scope: HTMLElement, id: string): HTMLElement {
  const matches = [...scope.querySelectorAll<HTMLElement>(".id-text")].filter(
    (el) => el.dataset.id === id,
  );
  if (matches.length === 0) throw new Error(`id span not found: ${JSON.stringify(id)}`);
  return matches[0];
}

/** 容器内包含该 id 的按钮（冲突组/试移列表）。 */
function clickIdButton(scope: HTMLElement, id: string): void {
  const btn = idSpan(scope, id).closest("button");
  if (!btn) throw new Error(`no button wraps id: ${JSON.stringify(id)}`);
  fireEvent.click(btn);
}

function section(heading: RegExp): HTMLElement {
  const h2 = [...document.querySelectorAll("h2")].find((h) => heading.test(h.textContent ?? ""));
  if (!h2) throw new Error(`section not found: ${heading}`);
  return h2.closest("section")!;
}

async function importBaseline(): Promise<{ groups: HTMLElement; trial: HTMLElement }> {
  const utils = render(<App />);
  const fileInput = utils.container.querySelector('input[type="file"]')!;
  fireEvent.change(fileInput, { target: { files: [patchFile(identityPatch())] } });
  await screen.findByText("冲突组（3）", { selector: "h2" });
  const groups = section(/^冲突组/);
  const trial = section(/^试移灯具/);
  return { groups, trial };
}

/** 试移面板内“原位/目标位直接冲突”列表容器。 */
function conflictList(trial: HTMLElement, kind: RegExp): HTMLElement {
  return within(trial).getByText(kind).parentElement!;
}

function listIds(list: HTMLElement): string[] {
  return [...list.querySelectorAll(".chip .id-text")].map((el) =>
    (el as HTMLElement).dataset.id!,
  );
}

function fixtureDl(trial: HTMLElement): HTMLElement {
  return trial.querySelector("dl.fixture")!;
}

/** jsdom 的 Blob 没有 text()，用 FileReader 读回字符串。 */
function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** 当前选中灯具的明细行（id/universe/start/...）文本。 */
function fixtureRow(dl: HTMLElement, label: string): string {
  const dts = [...dl.querySelectorAll("dt")];
  const i = dts.findIndex((dt) => dt.textContent === label);
  return dl.querySelectorAll("dd")[i].textContent ?? "";
}

describe("灯具 id 逐字节身份验收", () => {
  beforeEach(() => {
    // jsdom 下 URL.createObjectURL 不存在；下载用例会替换锚点 click
    vi.stubGlobal(
      "URL",
      Object.assign({}, URL, {
        createObjectURL: vi.fn(() => "blob:mock"),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  afterEach(() => {
    cleanup(); // vite 配置未开启 vitest globals，RTL 无法自动清理，避免多实例累积
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("入口 1：查找框逐字符匹配，前导/尾随/连续/纯空格 id 均可选中", async () => {
    const { trial } = await importBaseline();
    const input = within(trial).getByPlaceholderText(/按 id 查找/) as HTMLInputElement;
    const choose = within(trial).getByRole("button", { name: "选择" });

    // 前导空格
    fireEvent.change(input, { target: { value: LA } });
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(choose);
    let dl = fixtureDl(trial);
    expect(idSpan(dl, LA).dataset.id).toBe(LA);
    expect(idSpan(dl, LA).textContent).toBe("␣A");

    // 连续空格
    fireEvent.change(input, { target: { value: A2B } });
    fireEvent.click(choose);
    dl = fixtureDl(trial);
    expect(idSpan(dl, A2B).dataset.id).toBe(A2B);
    expect(idSpan(dl, A2B).textContent).toBe("A␣␣B");

    // 纯空格 id 同样可操作（trim 之后会变成空串而无法选中）
    fireEvent.change(input, { target: { value: WS } });
    expect(input.value).toBe(WS);
    expect((choose as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(choose);
    dl = fixtureDl(trial);
    expect(idSpan(dl, WS).dataset.id).toBe(WS);
    expect(idSpan(dl, WS).textContent).toBe("␣␣");
    expect(fixtureRow(dl, "universe")).toBe("2");
    expect(fixtureRow(dl, "start")).toBe("22");

    // 尾随空格：不得被修剪成 "A"
    fireEvent.change(input, { target: { value: AR } });
    fireEvent.click(choose);
    dl = fixtureDl(trial);
    expect(idSpan(dl, AR).dataset.id).toBe(AR);
    expect(idSpan(dl, AR).textContent).toBe("A␣");
    expect(fixtureRow(dl, "start")).toBe("21");

    // 普通无空格 id 行为不变
    fireEvent.change(input, { target: { value: A } });
    fireEvent.click(choose);
    dl = fixtureDl(trial);
    expect(idSpan(dl, A).textContent).toBe(A);
  });

  it("入口 1b：查找失败不改变当前选择、试移结果与补丁，输入原样保留", async () => {
    const { trial } = await importBaseline();
    const input = within(trial).getByPlaceholderText(/按 id 查找/) as HTMLInputElement;
    const choose = within(trial).getByRole("button", { name: "选择" });

    // 先选中 "A"，面板自动出现原位冲突（与 "A " 在端点 21 相接）
    fireEvent.change(input, { target: { value: A } });
    fireEvent.click(choose);
    let dl = fixtureDl(trial);
    expect(idSpan(dl, A).dataset.id).toBe(A);
    const origin = conflictList(trial, /^原位直接冲突/);
    expect(listIds(origin)).toEqual([AR]);

    // 输入不存在的 id（含“看起来像被修剪过”的形态）
    fireEvent.change(input, { target: { value: "A  " } }); // 补丁里只有 "A "，没有 "A  "
    fireEvent.click(choose);
    const warn = document.querySelector(".banner.warn")!;
    expect(idSpan(warn as HTMLElement, "A  ").textContent).toBe("A␣␣");

    // 当前选择仍是 "A"、试移结果仍是原位 ["A "]，输入也未被改写
    dl = fixtureDl(trial);
    expect(idSpan(dl, A).dataset.id).toBe(A);
    expect(listIds(conflictList(trial, /^原位直接冲突/))).toEqual([AR]);
    expect(input.value).toBe("A  ");

    // 再用会修剪成 "A" 的形态 " A "（不存在）查找，同样不得落到 "A" 上
    fireEvent.change(input, { target: { value: " A " } });
    fireEvent.click(choose);
    expect(idSpan(fixtureDl(trial), A).dataset.id).toBe(A);
    expect(input.value).toBe(" A ");
    expect((choose as HTMLButtonElement).disabled).toBe(false);
  });

  it("入口 2：冲突组按钮逐字节选择，视觉相近 id 明确可分", async () => {
    const { groups, trial } = await importBaseline();

    // 同屏存在 "A  B" 与 "A B"：渲染文本必须不同
    expect(idSpan(groups, A2B).textContent).toBe("A␣␣B");
    expect(idSpan(groups, AB).textContent).toBe("A␣B");
    expect(idSpan(groups, LA).textContent).toBe("␣A");
    expect(idSpan(groups, AR).textContent).toBe("A␣");
    expect(idSpan(groups, WS).textContent).toBe("␣␣");
    expect(idSpan(groups, COMMA).textContent).toBe(COMMA);
    expect(idSpan(groups, QUOTE).textContent).toBe(QUOTE);
    // title 是 JSON 引用形式：引号被转义，可据此区分
    expect(idSpan(groups, QUOTE).getAttribute("title")).toBe('"a\\"b"');
    expect(idSpan(groups, COMMA).getAttribute("title")).toBe('"a,b"');

    // 点击 "A  B"（不能误选 "A B"）
    clickIdButton(groups, A2B);
    const dl = fixtureDl(trial);
    expect(idSpan(dl, A2B).dataset.id).toBe(A2B);
    expect(fixtureRow(dl, "universe")).toBe("1");
    expect(fixtureRow(dl, "start")).toBe("11");

    // 选中态落在精确 id 的按钮上（属性选择器保留空格）
    const selected = groups.querySelector('.chip.selected .id-text[data-id="A  B"]');
    expect(selected).not.toBeNull();
    expect(groups.querySelector('.chip.selected .id-text[data-id="A B"]')).toBeNull();

    // 纯空格 id 按钮也能点选
    clickIdButton(groups, WS);
    expect(idSpan(fixtureDl(trial), WS).dataset.id).toBe(WS);
  });

  it("入口 3：试移列表按钮切换选择，提交落到精确目标且重算分组", async () => {
    const { groups, trial } = await importBaseline();
    const input = within(trial).getByPlaceholderText(/按 id 查找/) as HTMLInputElement;

    fireEvent.change(input, { target: { value: A } });
    fireEvent.click(within(trial).getByRole("button", { name: "选择" }));

    // "A"[20,21] 的原位冲突仅 "A "[21,22]
    expect(listIds(conflictList(trial, /^原位直接冲突/))).toEqual([AR]);

    // 入口 3：点击原位冲突按钮 "A " → 选择切换到该精确灯具
    const origin = conflictList(trial, /^原位直接冲突/);
    fireEvent.click(idSpan(origin, AR).closest("button")!);
    let dl = fixtureDl(trial);
    expect(idSpan(dl, AR).dataset.id).toBe(AR);

    // "A "[21,22] 与两侧的 "  "[22,23]、"A"[20,21] 端点相接；按 UTF-8 字节序 "  " 在 "A" 前
    expect(listIds(conflictList(trial, /^原位直接冲突/))).toEqual([WS, A]);

    // 试移到无冲突的 u9/1：输入非法时空列表不会出现
    const numInputs = trial.querySelectorAll(".inputs input");
    fireEvent.change(numInputs[0], { target: { value: "9" } });
    fireEvent.change(numInputs[1], { target: { value: "1" } });
    fireEvent.click(within(trial).getByRole("button", { name: "试移" }));
    expect(within(trial).getByText(/目标位无冲突，可提交/)).toBeTruthy();
    expect(listIds(conflictList(trial, /^目标位直接冲突/))).toEqual([]);

    // 提交：横幅中的 id 必须仍是 "A "（尾随空格未丢）
    fireEvent.click(within(trial).getByRole("button", { name: "提交移动" }));
    const ok = document.querySelector(".banner.ok")!;
    expect(idSpan(ok as HTMLElement, AR).dataset.id).toBe(AR);
    expect(idSpan(ok as HTMLElement, AR).textContent).toBe("A␣");

    // 补丁确实改到了 "A "：再次按精确 id 查找，位置是 u9/1；u2 链断开，冲突组 3 → 2
    fireEvent.change(input, { target: { value: AR } });
    fireEvent.click(within(trial).getByRole("button", { name: "选择" }));
    dl = fixtureDl(trial);
    expect(fixtureRow(dl, "universe")).toBe("9");
    expect(fixtureRow(dl, "start")).toBe("1");
    expect(within(groups).getByText("冲突组（2）", { selector: "h2" })).toBeTruthy();
    // "A" 与 "  " 已无冲突（链被桥接灯具拆开），两者均不再出现在任何冲突组
    expect(groups.querySelectorAll('.id-text[data-id="A "]').length).toBe(0);
    expect(groups.querySelectorAll('.id-text[data-id="  "]').length).toBe(0);
    expect(groups.querySelectorAll('.id-text[data-id="A"]').length).toBe(0);
  });

  it("修订复核：表格、采纳集合逐项可辨；下载 JSON 保持 id 逐字节身份且不写回引擎", async () => {
    const { groups, trial } = await importBaseline();
    const review = section(/^修订补丁复核/);
    const fileInputs = document.querySelectorAll('input[type="file"]');
    const reviewInput = fileInputs[1];

    // 仅把两个含标点的 id 移到各自空闲 universe（均可采纳，互不新增冲突）
    const candidate = identityPatch().map((fx) => {
      if (fx.id === COMMA) return { ...fx, universe: 8, start: 1 };
      if (fx.id === QUOTE) return { ...fx, universe: 9, start: 1 };
      return fx;
    });

    // 捕获下载内容：createObjectURL 收到的 Blob 即下载体（jsdom Blob 无 text()，用 FileReader 读回）
    let downloadedBlob: Blob | null = null;
    vi.stubGlobal(
      "URL",
      Object.assign({}, URL, {
        createObjectURL: (blob: Blob) => {
          downloadedBlob = blob;
          return "blob:mock";
        },
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    fireEvent.change(reviewInput, { target: { files: [patchFile(candidate, "candidate.json")] } });

    // 结论横幅
    await within(review).findByText(/共 2 项提案：采纳 2 项、拒绝 0 项/);

    // 复核表格两行，id 逐字节渲染（逗号/引号不影响列结构）
    const rows = [...review.querySelectorAll(".review-table tbody tr")];
    expect(rows.length).toBe(2);
    const rowIds = rows.map((r) => r.querySelector("td .id-text") as HTMLElement);
    expect(rowIds.map((s) => s.dataset.id!).sort(compareUtf8)).toEqual(
      [QUOTE, COMMA].sort(compareUtf8),
    );
    expect(rowIds.find((s) => s.dataset.id === QUOTE)!.textContent).toBe('a"b');
    expect(rowIds.find((s) => s.dataset.id === COMMA)!.textContent).toBe("a,b");

    // 采纳集合逐项展示（不再 join(", ")）：顺序为 compareUtf8 —— '"' (0x22) < ',' (0x2C)
    const adopted = [...review.querySelectorAll(".adopt-chip .id-text")] as HTMLElement[];
    expect(adopted.map((s) => s.dataset.id)).toEqual([QUOTE, COMMA]);
    expect(adopted.map((s) => s.textContent)).toEqual(['a"b', "a,b"]);
    // 旧实现的拼接形式绝不能再出现
    expect(review.textContent).not.toContain('a"b, a,b');

    // 下载：截获 Blob 文本并逐字节核对
    fireEvent.click(within(review).getByRole("button", { name: "下载合并结果 JSON" }));
    expect(downloadedBlob).not.toBeNull();
    const downloaded = await readBlob(downloadedBlob!);
    expect(downloaded).not.toBe("");
    const parsed = JSON.parse(downloaded) as Fixture[];
    expect(parsed.length).toBe(8);
    // 可被 parsePatch 回读
    const reparsed = parsePatch(parsed);
    expect(reparsed).not.toBeNull();
    // 按 compareUtf8 排序
    expect(parsed.map((p) => p.id)).toEqual(
      identityPatch()
        .map((p) => p.id)
        .sort(compareUtf8),
    );
    const byId = new Map(parsed.map((p) => [p.id, p]));
    // 视觉相近 id 全部以精确字节存在
    for (const id of [A, LA, AR, WS, A2B, AB, COMMA, QUOTE]) expect(byId.has(id)).toBe(true);
    // 采纳项取候选位置，其余保留基线
    expect(byId.get(COMMA)).toMatchObject({ universe: 8, start: 1, footprint: 2 });
    expect(byId.get(QUOTE)).toMatchObject({ universe: 9, start: 1, footprint: 2 });
    expect(byId.get(WS)).toMatchObject({ universe: 2, start: 22, footprint: 2 });
    expect(byId.get(A2B)).toMatchObject({ universe: 1, start: 11, footprint: 2 });
    // 下载文本中各 id 的 JSON 引用形式原样可见（引号转义、空格保留）
    expect(downloaded).toContain(JSON.stringify(A2B));
    expect(downloaded).toContain(JSON.stringify(WS));
    expect(downloaded).toContain(JSON.stringify(QUOTE));
    expect(downloaded).toContain(JSON.stringify(COMMA));

    // 与库实现的确定性序列化一致：排序 + JSON.stringify(null, 2)
    const expectedMerged = identityPatch()
      .map((fx) =>
        fx.id === COMMA
          ? { ...fx, universe: 8, start: 1 }
          : fx.id === QUOTE
            ? { ...fx, universe: 9, start: 1 }
            : fx,
      )
      .sort((x, y) => compareUtf8(x.id, y.id));
    expect(downloaded).toBe(serializePatch(expectedMerged));

    // 不写回引擎：冲突组仍是基线上的 3 个
    expect(within(groups).getByText("冲突组（3）", { selector: "h2" })).toBeTruthy();
    expect(idSpan(groups, COMMA).dataset.id).toBe(COMMA);
    expect(idSpan(groups, QUOTE).dataset.id).toBe(QUOTE);

    // 试移面板仍可在 u3 找到基线位置的灯具
    fireEvent.change(within(trial).getByPlaceholderText(/按 id 查找/), {
      target: { value: COMMA },
    });
    fireEvent.click(within(trial).getByRole("button", { name: "选择" }));
    expect(fixtureRow(fixtureDl(trial), "universe")).toBe("3");
  });

  it("IdText：只改变空格的可视化，data-id/title 始终是原始字节", () => {
    const { container } = render(<IdText id={' x"y, z '} />);
    const span = container.querySelector(".id-text") as HTMLElement;
    expect(span.dataset.id).toBe(' x"y, z ');
    expect(span.getAttribute("title")).toBe(JSON.stringify(' x"y, z '));
    expect(span.textContent).toBe('␣x"y,␣z␣');
    // 不含真实空格的 id 文本不变
    const plain = render(<IdText id={'a"b,c'} />);
    expect(plain.container.textContent).toBe('a"b,c');
  });
});
