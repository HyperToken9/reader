"""Generate the synthetic Blitz text test bench: Typst source, cases.json, PDF.
All text here is original. Run with the proto09 venv (typst + pypdf).
  venv/bin/python gen_bench.py OUTDIR
"""
import json, re, sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "bench")
OUT.mkdir(parents=True, exist_ok=True)

SYM = 'text(font: "DejaVu Sans")'
C = []  # (id, section, label, typst_body, on_page, ideal)


def case(cid, label, body, on_page, ideal, note=""):
    C.append(dict(id=cid, section=cid[0], label=label, typst=body.strip("\n"), on_page=on_page, ideal=ideal, note=note))


# ---------------------------------------------------------------- J: junk
case("J-01", "Tall brackets drawn by the maths engine",
     r'A column vector $vec(x, y, z, w, 1, delim: "[")$ is written vertically on the page.',
     "A five-row column vector with tall square brackets, inline in a sentence.",
     "A column vector x, y, z, w, one is written vertically on the page.")
case("J-02", "Matrix bracket pieces set as separate glyphs",
     '#grid(columns: 5, column-gutter: 5pt, row-gutter: 2pt,\n'
     f'  {SYM}[⎡], [1], [0], [0], {SYM}[⎤],\n  {SYM}[⎢], [0], [1], [0], {SYM}[⎥],\n  {SYM}[⎣], [0], [0], [1], {SYM}[⎦])\n'
     'The grid above is the identity matrix, built the way older equation editors build it.',
     "A 3x3 identity matrix whose brackets are the separate pieces ⎡ ⎢ ⎣ ⎤ ⎥ ⎦.",
     "(skip the matrix, or: the three by three identity matrix.) The grid above is the identity matrix, built the way older equation editors build it.")
case("J-03", "Box-drawing characters in a directory tree",
     '#text(font: "DejaVu Sans Mono", size: 9pt)[#raw("app/\\n├── renderer/\\n│   └── main.js\\n└── electron/\\n    └── tts.js")]\n\nThe tree shows where the two scripts live.',
     "A monospace directory tree drawn with ├── │ └── characters.",
     "(a code block: app, renderer, main.js, electron, tts.js, or skipped) The tree shows where the two scripts live.")
case("J-04", "Dot leaders in a table of contents",
     '#box(width: 10cm)[Chapter 1 Vectors and Scalars #box(width: 1fr, repeat[.]) 17] \\\n'
     '#box(width: 10cm)[Chapter 2 The Calculus of Motion #box(width: 1fr, repeat[.]) 43] \\\n'
     '#box(width: 10cm)[Chapter 3 Springs #box(width: 1fr, repeat[.]) 81]',
     "Three table-of-contents lines with dotted leaders to page numbers.",
     "Chapter 1, Vectors and Scalars, page 17. Chapter 2, The Calculus of Motion, page 43. Chapter 3, Springs, page 81.")
case("J-05", "Running header and page number",
     'Every page of this document carries a running header ("Blitz text test bench") and a page number in the footer. Neither should be read aloud, and neither should be glued onto the first or last sentence of a page.',
     "Body text; the furniture itself is in the header/footer of every page.",
     "Every page of this document carries a running header and a page number in the footer. (Header and page number never spoken.)")
case("J-06", "A sentence broken across a page",
     'This sentence is placed at the very bottom of a page so that it has to continue on the next page, which means the page number and the running header sit in the middle of it when the text is extracted page by page, and a reader that segments one page at a time will cut it into two pieces, each of which it will then treat as a sentence of its own, with the first piece ending in mid-air and the second piece starting in the middle of a clause that the listener has already half forgotten by the time the next page has been fetched, rendered and read.',
     "One long sentence flowing over a page break.",
     "The whole sentence as one unit, with no page number or header inside it.")
case("J-07", "Private-use glyph (icon font)",
     '#text(font: "DejaVu Sans")[☞] Keep the lid closed while the centrifuge is spinning.',
     "A pointing-hand icon whose ToUnicode entry was rewritten to private-use U+F0E0 (post-processed), then a sentence.",
     "(icon skipped, or 'Note:') Keep the lid closed while the centrifuge is spinning.",
     note="Post-processed: ToUnicode for ☞ remapped to U+F0E0, as icon fonts do.")
case("J-08", "Unmappable glyph arriving as a control character",
     'The impulse equals the change in momentum, #text(font: "DejaVu Serif")[Δ]p, over the short interval #text(font: "DejaVu Serif")[Δ]t.',
     "Δp and Δt, with the Δ glyph's ToUnicode rewritten to U+0003 (post-processed), as in Millington p.60.",
     "The impulse equals the change in momentum, delta p, over the short interval delta t.",
     note="Post-processed: ToUnicode for Δ in this font remapped to U+0003.")
case("J-09", "Zero-width space inside a word",
     'The data#sym.zws;base was rebuilt overnight, and the time#sym.zws;stamp column was kept.',
     "'database' and 'timestamp' each containing an invisible U+200B.",
     "The database was rebuilt overnight, and the timestamp column was kept.")
case("J-10", "Soft hyphen inside a word",
     'Tune one hyper#"\\u{00AD}"parameter at a time, and never more than one meta#"\\u{00AD}"parameter.',
     "'hyperparameter' and 'metaparameter' each containing an invisible U+00AD soft hyphen.",
     "Tune one hyperparameter at a time, and never more than one metaparameter.")
case("J-11", "Decorative bullets",
     f'#{SYM}[❖] Weigh the sample. \\\n#{SYM}[➤] Dissolve it in water. \\\n#{SYM}[■] Record the temperature.',
     "Three lines starting with the ornaments ❖ ➤ ■.",
     "Weigh the sample. Dissolve it in water. Record the temperature.")
case("J-12", "Labels inside a figure",
     '#figure(box(width: 7cm, height: 3cm, stroke: 0.5pt)[\n'
     '  #place(top + left, dx: 3pt, dy: 3pt)[v (m/s)]\n  #place(bottom + right, dx: -3pt, dy: -3pt)[t (s)]\n'
     '  #place(bottom + left, dx: 3pt, dy: -3pt)[0]\n  #place(center + horizon)[A]\n  #place(top + right, dx: -12pt, dy: 12pt)[B]\n'
     '  #place(bottom + left, line(start: (10pt, -8pt), end: (180pt, -70pt), stroke: 0.6pt))\n'
     '], caption: [Velocity against time for a falling ball.])',
     "A boxed plot with axis labels 'v (m/s)', 't (s)', '0', point labels A and B, and a caption.",
     "Figure 1: Velocity against time for a falling ball. (Labels inside the plot are not read.)")
case("J-13", "Ornamental section break",
     'The first scene ends here.\n#align(center)[#text(font: "DejaVu Sans")[❧ ❧ ❧]]\nThe second scene begins the next morning.',
     "Two sentences separated by a centred row of fleurons.",
     "The first scene ends here. (pause) The second scene begins the next morning.")
case("J-14", "Line numbers in a code listing",
     '#grid(columns: 2, column-gutter: 8pt, text(font: "DejaVu Sans Mono", size: 9pt, fill: gray)[1 \\ 2 \\ 3],\n'
     '  text(size: 9pt)[#raw("let total = 0;\\nfor (const x of xs) total += x;\\nreturn total;")])\n'
     'The loop on line 2 adds every element.',
     "A three-line code listing with grey line numbers 1 2 3 in a gutter.",
     "(code announced or read without the gutter numbers) The loop on line 2 adds every element.")
case("J-15", "Watermark behind the text",
     'This page carries a large diagonal SPECIMEN watermark behind the body text. It is decoration, not content.',
     "Body text over a pale diagonal watermark (page background).",
     "This page carries a large diagonal watermark behind the body text. It is decoration, not content. (The word 'SPECIMEN' itself is not read.)")

# ---------------------------------------------------------------- S: symbols
case("S-01", "Capital delta", 'The change Δx is small compared with x itself.', "Δx (U+0394, a font with proper mapping).", "The change delta x is small compared with x itself.")
case("S-02", "Greek letters in prose", 'The angles α, β and θ sum to π, and λ is the wavelength while σ is the spread.', "α β θ π λ σ in running text.", "The angles alpha, beta and theta sum to pi, and lambda is the wavelength while sigma is the spread.")
case("S-03", "Comparison signs", 'If x ≤ 5 and y ≥ 2, then x ≠ y need not hold, and π ≈ 3.14.', "≤ ≥ ≠ ≈", "If x is less than or equal to 5 and y is greater than or equal to 2, then x not equal to y need not hold, and pi is approximately 3.14.")
case("S-04", "Plus-minus, times, divide", 'The rod is 12 ± 0.5 cm long; 3 × 4 = 12 and 12 ÷ 3 = 4.', "± × ÷ =", "The rod is 12 plus or minus 0.5 centimetres long; 3 times 4 equals 12 and 12 divided by 3 equals 4.")
case("S-05", "Degrees", 'Water boils at 100 °C, the body sits near 37 °C, and a right angle is 90°.', "°C with a space, 90° bare.", "Water boils at 100 degrees Celsius, the body sits near 37 degrees Celsius, and a right angle is 90 degrees.")
case("S-06", "Percent and per mille", 'Prices rose 15% this year, and the salinity is 35‰.', "% and ‰", "Prices rose 15 percent this year, and the salinity is 35 per mille.")
case("S-07", "Currencies", 'It cost \\$5.99 here, €20 in Paris, £3 in London, ¥500 in Tokyo and ₹100 in Delhi.', "$ € £ ¥ ₹ before amounts.", "It cost 5 dollars 99 here, 20 euros in Paris, 3 pounds in London, 500 yen in Tokyo and 100 rupees in Delhi.")
case("S-08", "Micro sign and units", 'Each cell is 10 µm wide, the dose is 5 µg/dL, and g = 9.81 m/s².', "µ is U+00B5 MICRO SIGN in the source; m/s² uses a superscript-two character.", "Each cell is 10 micrometres wide, the dose is 5 micrograms per decilitre, and g equals 9.81 metres per second squared.")
case("S-09", "Vulgar fractions", 'Add ½ cup of flour; ¾ of the class passed and ⅓ stayed behind.', "½ ¾ ⅓", "Add half a cup of flour; three quarters of the class passed and one third stayed behind.")
case("S-10", "Unicode superscripts and subscripts", 'We have x² + y³, a rate of 10⁻⁵ per second, and water is H₂O while CO₂ is a gas.', "x² y³ 10⁻⁵ H₂O CO₂ as Unicode characters.", "We have x squared plus y cubed, a rate of ten to the minus five per second, and water is H 2 O while C O 2 is a gas.")
case("S-11", "Typeset superscripts and subscripts", 'We have x#super(typographic: false)[2] + y#super(typographic: false)[3], a rate of 10#super(typographic: false)[−5] per second, and water is H#sub(typographic: false)[2]O while CO#sub(typographic: false)[2] is a gas.', "The same as S-10 but raised/lowered ordinary digits, as most PDFs do it.", "Same as S-10: x squared plus y cubed, ten to the minus five, H 2 O, C O 2.")
case("S-12", "Arrows", 'The reaction A → B is fast, the rule p ⇒ q is a premise, and prices went ↑ while sales went ↓.', "→ ⇒ ↑ ↓", "The reaction A to B (A goes to B) is fast, the rule p implies q is a premise, and prices went up while sales went down.")
case("S-13", "Primes", 'Compare f′(x) with f″(x); the shelf is 5′ 11″ tall.', "′ and ″ as derivative marks and as feet/inches.", "Compare f prime of x with f double prime of x; the shelf is 5 feet 11 inches tall.")
case("S-14", "Big operators as text", 'The ∑ of the terms diverges, the ∫ from 0 to ∞ converges, and √2 is irrational.', "∑ ∫ ∞ √ in running text.", "The sum of the terms diverges, the integral from 0 to infinity converges, and the square root of 2 is irrational.")
case("S-15", "Set and logic symbols", 'For every x ∈ S there is a y ∉ T; ∀ε > 0 ∃δ > 0 such that the bound holds.', "∈ ∉ ∀ ∃", "For every x in S there is a y not in T; for all epsilon greater than 0 there exists delta greater than 0 such that the bound holds.")
case("S-16", "Mathematical italic letters as text", 'The probability 𝑃(𝐴) rises with the parameter 𝜽, and 𝑛 is the sample size.', "𝑃 𝐴 𝜽 𝑛 typed as Unicode mathematical alphanumerics (what modern maths fonts emit).", "The probability P of A rises with the parameter theta, and n is the sample size.")
case("S-17", "Defined-as and other relations", 'Let 𝑓 ≜ 𝑔 + 1, assume a ∝ b, and note that A ⊆ B.', "≜ ∝ ⊆", "Let f be defined as g plus 1, assume a is proportional to b, and note that A is a subset of B.")
case("S-18", "Section, copyright and trademark signs", 'See § 4.2 and ¶ 3; the text is © 2026 Blitz, and Kokoro™ is named here only as an example®.', "§ ¶ © ™ ®", "See section 4.2 and paragraph 3; the text is copyright 2026 Blitz, and Kokoro trademark is named here only as an example registered.")
case("S-19", "Ellipsis", 'Wait… then what happened to the other half?', "Single-character ellipsis U+2026.", "Wait... (pause) then what happened to the other half?")
case("S-20", "En dash ranges and pairs", 'Read pages 10–20 of the 1990–1995 report on the London–Paris line.', "– between numbers and between names.", "Read pages 10 to 20 of the 1990 to 1995 report on the London to Paris line.")
case("S-21", "Em dash", 'The result—surprisingly—was exactly zero.', "— with no surrounding spaces.", "The result, surprisingly, was exactly zero. (with pauses)")
case("S-22", "Minus sign versus hyphen", 'At −40 °C the two scales agree; the hyphenated #"-"40 is the same number.', "U+2212 minus vs ASCII hyphen.", "At minus 40 degrees Celsius the two scales agree; the hyphenated minus 40 is the same number.")
case("S-23", "Ampersand, hash, slash and ratio", 'R&D spent \\#3 of the budget on a 3:2 ratio of km/h tests and/or audits.', "& # : / in prose", "R and D spent number 3 of the budget on a 3 to 2 ratio of kilometres per hour tests and or audits.")

# ---------------------------------------------------------------- P: prose mechanics
case("P-01", "Ligatures fi fl ff ffi ffl", 'The official efficient affluent fluffy fjord shuffle baffled five office staff.', "Libertinus Serif with standard ligatures on (fi, fl, ff, ffi, ffl glyphs).", "The official efficient affluent fluffy fjord shuffle baffled five office staff.")
case("P-02", "Hyphenated line ends", '#block(width: 4.2cm)[#set par(justify: true)\n#set text(hyphenate: true)\nInternationalisation and incomprehensibility are characteristically troublesome for straightforward extraction.]',
     "A narrow justified column where long words are hyphenated across line ends.", "Internationalisation and incomprehensibility are characteristically troublesome for straightforward extraction.")
case("P-03", "Compound hyphen at a line end", '#block(width: 1.45cm)[#set par(justify: false)\nA well-known self-contained state-of-the-art object-oriented design.]',
     "A very narrow column so the real hyphens of compounds fall at line ends.", "A well-known self-contained state-of-the-art object-oriented design.")
case("P-04", "Tight letter tracking", '#text(tracking: -0.05em)[Tracking minus five hundredths keeps these words apart.] \\\n#text(tracking: -0.12em)[Tracking minus twelve hundredths may start to weld.] \\\n#text(tracking: -0.2em)[Tracking minus two tenths welds these words together.]',
     "Three lines of increasingly tight letter-spacing (-0.05em, -0.12em, -0.2em).", "All three sentences with normal word boundaries.")
case("P-05", "Wide letter-spacing", '#text(tracking: 0.3em)[WIDELY SPACED HEADING] \\\nThe heading above is letter-spaced the way chapter openers often are.',
     "An all-caps heading with +0.3em tracking.", "Widely spaced heading. The heading above is letter-spaced the way chapter openers often are.")
case("P-06", "Small caps", '#smallcaps[Nasa] and the #smallcaps[Royal Society] both run #smallcaps[Unix] servers.', "Small-cap glyphs (OpenType smcp) for NASA, Royal Society, UNIX.", "NASA and the Royal Society both run UNIX servers.")
case("P-07", "Drop cap", '#grid(columns: (auto, 1fr), gutter: 3pt, text(size: 30pt)[O], [nce upon a time a reader met a drop cap and had to decide what to make of it. The large letter sits in its own box beside the paragraph.])',
     "A large initial O in its own box, the rest of the word 'nce' starting the paragraph.", "Once upon a time a reader met a drop cap and had to decide what to make of it. The large letter sits in its own box beside the paragraph.")
case("P-08", "Footnote markers", 'This claim#footnote[The note text appears at the foot of the page.] needs support, and so does this one#footnote[A second note.].',
     "Two superscript footnote numbers attached to words; the notes print at the page foot.", "This claim needs support, and so does this one. (Markers silent or 'footnote 1'; the note text read later or on request.)")
case("P-09", "URL", 'Visit https://example.org/docs/v2?lang=en for the details.', "A URL with a path and a query string.", "Visit example dot org slash docs slash v2 for the details.")
case("P-10", "Email address", 'Write to reader.help\\@example.com with questions.', "An email address.", "Write to reader dot help at example dot com with questions.")
case("P-11", "Code identifiers in prose", 'Call `parse_config()` first, then `foo.bar(x)`, and finally `getElementById` on the `MAX_SIZE` buffer.',
     "snake_case, a dotted call, camelCase and SCREAMING_CASE in inline code.", "Call parse config first, then foo dot bar of x, and finally get element by id on the max size buffer.")
case("P-12", "Numbers", 'The total was 1,234.56 units; version 3.10 replaced 3.9; the tolerance is 1e-5; and 0.000001 is a millionth.',
     "Thousands separator, version number, scientific notation, long decimal.", "The total was one thousand two hundred thirty-four point five six units; version three point ten replaced three point nine; the tolerance is one times ten to the minus five; and zero point zero zero zero zero zero one is a millionth.")
case("P-13", "Dates and times", 'The run started on 2026-10-24 at 14:30 and ended on 24 Oct 2026 at 4:05 pm.', "ISO date, 24-hour time, abbreviated month.", "The run started on the twenty-fourth of October 2026 at fourteen thirty and ended on 24 October 2026 at four oh five pm.")
case("P-14", "Abbreviations with full stops", 'Some solvents, e.g. ethanol, are safe, i.e. mostly. Dr. Rao showed in Fig. 3 that approx. 4 km is enough, as Smith et al. (2019) found on p. 12, vs. 6 km before.',
     "e.g. i.e. Dr. Fig. approx. et al. p. vs.", "Some solvents, for example ethanol, are safe, that is mostly. Doctor Rao showed in figure 3 that approximately 4 kilometres is enough, as Smith and others (2019) found on page 12, versus 6 kilometres before. (Split into exactly two sentences.)")
case("P-15", "Nested quotes and parentheses", '“She said, ‘the (very (deeply) nested) case’ works,” he wrote (and meant it).', "Curly double and single quotes, nested parentheses.", "She said, the very deeply nested case works, he wrote, and meant it.")
case("P-16", "Numbered list", '+ Heat the solution.\n+ Add the reagent.\n+ Stir for two minutes.', "A three-item numbered list (1. 2. 3.).", "One: heat the solution. Two: add the reagent. Three: stir for two minutes. (or without the numbers)")
case("P-17", "Lettered list in a sentence", 'The kit needs (a) a beaker, (b) a burner and (c) a timer.', "(a) (b) (c) inline.", "The kit needs a, a beaker, b, a burner and c, a timer.")
case("P-18", "Two-column section", '#columns(2, gutter: 8mm)[The left column starts this thought and carries it down to the bottom of the column before it stops. #colbreak() The right column picks the story up again and finishes it here.]',
     "Two short columns side by side.", "The left column starts this thought and carries it down to the bottom of the column before it stops. The right column picks the story up again and finishes it here.")
case("P-19", "Heading without a full stop", '#text(weight: "bold", size: 13pt)[Energy and Work] \\\nWork is force times distance.',
     "A bold heading line with no terminal punctuation, then a sentence.", "Energy and Work. (pause) Work is force times distance.")
case("P-20", "Roman numerals", 'Chapter IV covers Henry VIII and the aftermath of World War II.', "IV VIII II", "Chapter four covers Henry the Eighth and the aftermath of World War Two.")
case("P-21", "Accented letters", 'The naïve café owner admired the façade designed by Schrödinger’s cousin.', "ï é ç ö", "The naive cafe owner admired the facade designed by Schrodinger's cousin.")
case("P-22", "Initials and acronyms", 'J. R. R. Tolkien never visited the U.S.A., but NASA and the SQL committee did.', "Spaced initials, dotted acronym, plain acronyms.", "J R R Tolkien never visited the U S A, but NASA and the S Q L committee did. (one sentence)")
case("P-23", "Citations", 'Earlier work [12, 14] disagreed with Smith (2019) and with the review by Lee et al. [7].', "Bracketed numeric citations and author-year.", "Earlier work disagreed with Smith 2019 and with the review by Lee and others. (bracket numbers silent or brief)")
case("P-24", "A small table", '#table(columns: 3, [Element], [Symbol], [Mass (u)], [Hydrogen], [H], [1.008], [Carbon], [C], [12.011])',
     "A 3x3 table with a header row.", "Element, symbol, mass: hydrogen, H, 1.008; carbon, C, 12.011. (row by row)")
case("P-25", "Code block", '#raw(block: true, lang: "c", "for (int i = 0; i < n; i++) {\\n  sum += a[i];\\n}")\nThe loop above sums the array.',
     "A three-line C loop in a code block.", "(code block announced or skipped) The loop above sums the array.")
case("P-26", "Chemical charges", 'Iron appears as Fe³⁺ and sulfate as SO₄²⁻ in the solution.', "Unicode superscript charges.", "Iron appears as F E three plus and sulfate as S O four two minus in the solution.")

# ---------------------------------------------------------------- M: maths in context
case("M-01", "Inline maths mid-sentence", 'The energy $E = m c^2$ follows from the rest mass alone.', "Inline equation set in the maths font.", "The energy E equals m c squared follows from the rest mass alone.")
case("M-02", "Inline fraction", 'The ratio $a/b$ equals $frac(1, 2)$ when $b = 2a$.', "Slash fraction and stacked inline fraction.", "The ratio a over b equals one half when b equals 2 a.")
case("M-03", "Numbered display equation", '#set math.equation(numbering: "(1)")\nNewton gives the law\n$ F = m a $\nwhich we use throughout.',
     "Display equation with an equation number (1).", "Newton gives the law F equals m a, equation 1, which we use throughout.")
case("M-04", "Display with a limit and fraction", 'The velocity is\n$ v = lim_(Delta t -> 0) (Delta p)/(Delta t) $\nwhich is the derivative of position.',
     "Millington-style limit of a difference quotient.", "The velocity is v equals the limit as delta t tends to zero of delta p over delta t, which is the derivative of position.")
case("M-05", "Matrix", 'The rotation matrix is\n$ R = mat(cos theta, -sin theta; sin theta, cos theta) $\nfor an angle $theta$.',
     "A 2x2 matrix with round brackets.", "The rotation matrix is R equals the two by two matrix cos theta, minus sin theta; sin theta, cos theta, for an angle theta. (or 'matrix skipped')")
case("M-06", "A sentence that is only maths", '$x^2 + y^2 = r^2$.', "An inline equation with nothing else in the paragraph.", "x squared plus y squared equals r squared.")
case("M-07", "Sum and integral displays", '$ sum_(i=1)^n i = (n(n+1))/2 quad "and" quad integral_0^1 x^2 dif x = 1/3 $',
     "Display sum with limits and a definite integral.", "The sum from i equals 1 to n of i equals n times n plus 1 over 2, and the integral from 0 to 1 of x squared d x equals one third.")
case("M-08", "Sub- and superscripts inline", 'Each term $x_i^2$ multiplies the entry $a_(i j)$ of the matrix.', "Stacked sub/superscripts.", "Each term x i squared multiplies the entry a i j of the matrix.")
case("M-09", "Greek inside maths", 'We require $alpha + beta = gamma$ and $Delta x > 0$.', "Greek letters set in the maths font (math italic).", "We require alpha plus beta equals gamma and delta x greater than zero.")
case("M-10", "Roots, norms and absolute values", 'The length is $sqrt(x^2 + y^2)$, written $norm(bold(v))$ or $|v|$.', "√ with vinculum, double bars, single bars.", "The length is the square root of x squared plus y squared, written the norm of v or the absolute value of v.")
case("M-11", "Vectors with arrows and hats", 'The dot product $arrow(v) dot arrow(w)$ uses the unit vector $hat(x)$.', "Accents set above letters.", "The dot product v dot w uses the unit vector x hat.")
case("M-12", "Set-builder notation", 'The positive reals are ${x in RR | x > 0}$.', "Braces, ∈, blackboard R.", "The positive reals are the set of x in R such that x is greater than zero.")
case("M-13", "Piecewise definition", '$ f(x) = cases(x "if" x >= 0, -x "otherwise") $\nThis is the absolute value.',
     "A cases block with a tall left brace.", "f of x equals x if x is at least zero, and minus x otherwise. This is the absolute value.")

# ---------------------------------------------------------------- document
HEAD = r'''// Blitz text test bench -- original text, generated by gen_bench.py.
#set document(title: "Blitz text test bench")
#set page(paper: "a4", margin: (x: 2.2cm, top: 2.6cm, bottom: 2.4cm),
  header: [#set text(size: 8.5pt, fill: luma(90)); Blitz text test bench #h(1fr) Draft 1],
  footer: context [#set text(size: 9pt); #h(1fr) #counter(page).display() #h(1fr)])
#set text(font: "Libertinus Serif", size: 11pt, lang: "en")
#set par(justify: true)
#show raw: set text(font: "DejaVu Sans Mono", size: 9pt)
#let case(id, label, body) = block(breakable: true, above: 1.3em, below: 0.6em)[
  #text(weight: "bold", fill: rgb("#1b4d89"))[#id.] #text(style: "italic")[#label.] \
  #body
]
#let section(t, intro) = [#pagebreak(weak: true) #text(size: 15pt, weight: "bold")[#t] #parbreak() #intro]

#align(center)[#text(size: 20pt, weight: "bold")[Blitz text test bench] \ #text(size: 11pt)[Hard cases for extraction and read-aloud. Every case has an ID like J-03.]]

How to use this document. Open it in Blitz and press play on any case. Section J holds things that should not be spoken, section S holds symbols that must be spoken meaningfully, section P holds prose mechanics, and section M holds mathematics in context. The companion report lists, for each case, what a good reader would say.
'''
SECTIONS = {
    "J": ("J. Junk that should not be spoken", "Each case below contains something a listener should never hear."),
    "S": ("S. Symbols that must be spoken", "Each case below contains a symbol whose meaning must survive into speech."),
    "P": ("P. Prose mechanics", "Each case below exercises the way ordinary prose is typeset."),
    "M": ("M. Mathematics in context", "Each case below puts mathematics where a reader meets it."),
}
parts = [HEAD]
for sec in "JSPM":
    t, intro = SECTIONS[sec]
    if sec == "J":
        parts.append('#set page(background: rotate(-35deg, text(80pt, fill: luma(232), weight: "bold")[SPECIMEN]))')
    if sec == "S":
        parts.append('#set page(background: none)')
    parts.append(f"#section[{t}][{intro}]")
    for c in C:
        if c["section"] == sec:
            if c["id"] == "J-06":  # push it to the foot of a page so it must overflow
                parts.append('#pagebreak()\n#v(21.6cm)')
            parts.append(f'#case("{c["id"]}", "{c["label"]}")[\n{c["typst"]}\n]')
src = "\n\n".join(parts) + "\n"
(OUT / "blitz-text-testbench.typ").write_text(src)
(OUT / "cases.json").write_text(json.dumps([{k: v for k, v in c.items() if k != "typst"} | {"typst_source": c["typst"]} for c in C], ensure_ascii=False, indent=1))
print(len(C), "cases")

import typst
typst.compile(str(OUT / "blitz-text-testbench.typ"), output=str(OUT / "raw.pdf"))

# ---- post-process: simulate an icon font (PUA) and an unmappable maths glyph (C0)
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, StreamObject
REMAP = {"DejaVuSerif": {"0394": "0003"}, "DejaVuSans": {"261E": "F0E0"}}
r = PdfReader(str(OUT / "raw.pdf"))
w = PdfWriter(clone_from=r)
done = []
seen = set()
for page in w.pages:
    fonts = page.get("/Resources", {}).get("/Font", {})
    for fk, fref in fonts.items():
        f = fref.get_object()
        base = str(f.get("/BaseFont", ""))
        key = next((k for k in REMAP if re.search(k + r"(?![-\w]*(Mono|Bold|Oblique|Condensed))", base)), None)
        if not key or "/ToUnicode" not in f or id(f) in seen:
            continue
        seen.add(id(f))
        tu = f["/ToUnicode"].get_object()
        data = tu.get_data().decode("latin-1")
        new = data
        for src_hex, dst_hex in REMAP[key].items():
            new = re.sub(r"<(" + src_hex + r")>", "<" + dst_hex + ">", new, flags=re.I)
        if new != data:
            tu.set_data(new.encode("latin-1"))
            done.append((base, REMAP[key]))
w.write(str(OUT / "blitz-text-testbench.pdf"))
print("remapped:", done)
