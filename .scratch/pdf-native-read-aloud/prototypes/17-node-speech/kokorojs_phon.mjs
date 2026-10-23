import { phonemize as l } from "phonemizer";
function o(e) {
  if (e.includes(".")) return e;
  if (e.includes(":")) {
    let [a, t] = e.split(":").map(Number);
    return 0 === t ? `${a} o'clock` : t < 10 ? `${a} oh ${t}` : `${a} ${t}`;
  }
  let a = parseInt(e.slice(0, 4), 10);
  if (a < 1100 || a % 1e3 < 10) return e;
  let t = e.slice(0, 2),
    r = parseInt(e.slice(2, 4), 10),
    n = e.endsWith("s") ? "s" : "";
  if (a % 1e3 >= 100 && a % 1e3 <= 999) {
    if (0 === r) return `${t} hundred${n}`;
    if (r < 10) return `${t} oh ${r}${n}`;
  }
  return `${t} ${r}${n}`;
}
function c(e) {
  const a = "$" === e[0] ? "dollar" : "pound";
  if (isNaN(Number(e.slice(1)))) return `${e.slice(1)} ${a}s`;
  if (!e.includes(".")) {
    let t = "1" === e.slice(1) ? "" : "s";
    return `${e.slice(1)} ${a}${t}`;
  }
  const [t, r] = e.slice(1).split("."),
    n = parseInt(r.padEnd(2, "0"), 10);
  return `${t} ${a}${"1" === t ? "" : "s"} and ${n} ${"$" === e[0] ? (1 === n ? "cent" : "cents") : 1 === n ? "penny" : "pence"}`;
}
function g(e) {
  let [a, t] = e.split(".");
  return `${a} point ${t.split("").join(" ")}`;
}
const u = new RegExp(
  `(\\s*[${((d = ';:,.!?¡¿—…"«»“”(){}[]'), d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}]+\\s*)+`,
  "g",
);
var d;
async function m(e, a = "a", t = !0) {
  t &&
    (e = (function (e) {
      return e
        .replace(/[‘’]/g, "'")
        .replace(/«/g, "“")
        .replace(/»/g, "”")
        .replace(/[“”]/g, '"')
        .replace(/\(/g, "«")
        .replace(/\)/g, "»")
        .replace(/、/g, ", ")
        .replace(/。/g, ". ")
        .replace(/！/g, "! ")
        .replace(/，/g, ", ")
        .replace(/：/g, ": ")
        .replace(/；/g, "; ")
        .replace(/？/g, "? ")
        .replace(/[^\S \n]/g, " ")
        .replace(/  +/, " ")
        .replace(/(?<=\n) +(?=\n)/g, "")
        .replace(/\bD[Rr]\.(?= [A-Z])/g, "Doctor")
        .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, "Mister")
        .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, "Miss")
        .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, "Mrs")
        .replace(/\betc\.(?! [A-Z])/gi, "etc")
        .replace(/\b(y)eah?\b/gi, "$1e'a")
        .replace(
          /\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g,
          o,
        )
        .replace(/(?<=\d),(?=\d)/g, "")
        .replace(
          /[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi,
          c,
        )
        .replace(/\d*\.\d+/g, g)
        .replace(/(?<=\d)-(?=\d)/g, " to ")
        .replace(/(?<=\d)S/g, " S")
        .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
        .replace(/(?<=X')S\b/g, "s")
        .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (e) => e.replace(/\./g, "-"))
        .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, "-")
        .trim();
    })(e));
  const r = (function (e, a) {
      const t = [];
      let r = 0;
      for (const n of e.matchAll(a)) {
        const a = n[0];
        r < n.index && t.push({ match: !1, text: e.slice(r, n.index) }),
          a.length > 0 && t.push({ match: !0, text: a }),
          (r = n.index + a.length);
      }
      return r < e.length && t.push({ match: !1, text: e.slice(r) }), t;
    })(e, u),
    n = "a" === a ? "en-us" : "en",
    s = (
      await Promise.all(
        r.map(async ({ match: e, text: a }) =>
          e ? a : (await l(a, n)).join(" "),
        ),
      )
    ).join("");
  let i = s
    .replace(/kəkˈoːɹoʊ/g, "kˈoʊkəɹoʊ")
    .replace(/kəkˈɔːɹəʊ/g, "kˈəʊkəɹəʊ")
    .replace(/ʲ/g, "j")
    .replace(/r/g, "ɹ")
    .replace(/x/g, "k")
    .replace(/ɬ/g, "l")
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, " ")
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, "z");
  return "a" === a && (i = i.replace(/(?<=nˈaɪn)ti(?!ː)/g, "di")), i.trim();
}
export const kokoroJsPhonemize = m;
