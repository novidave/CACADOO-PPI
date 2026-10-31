import type { CSSProperties } from "react";

/**
 * The shop page's background (artboard 12 "Celá stránka obchodu (jednotný dizajn)", at the owner's request
 * 2026-10-31): pale animals and leaves on #FFF8F0 behind the page's cards. Each drifts at its own speed as the page
 * scrolls (CSS `animation-timeline: scroll()`; browsers without it keep them still) and floats or swings gently;
 * nothing moves with "reduce motion". Decorative only (`aria-hidden`, no pointer events), plain SVG written on the
 * server: no JavaScript, no requests, never in front of the content. Styles in `@/components/shopPage.css` (`.ppi-zoo`).
 */

interface Animal {
  /** where it sits on the page (from the top, at one edge) and its width */
  place: Record<string, string>;
  /** its scroll drift: from --p0 at the top of the page to --p1 at the bottom */
  move: Record<string, string>;
  cls: string;
  /** its float: --fx sideways, --fr turn */
  float: Record<string, string>;
  /** the drawing (static, from the design) */
  svg: string;
}

const ANIMALS: Animal[] = [
  {
    "place": {
      "top": "90px",
      "right": "-34px",
      "width": "150px"
    },
    "move": {
      "--p0": "0px",
      "--p1": "-320px"
    },
    "cls": "ppi-zoo-float",
    "float": {
      "--fr": "-3deg"
    },
    "svg": "<svg viewBox=\"0 0 120 140\" width=\"150\" height=\"175\"><path d=\"M84 8l-2-7M92 8l1-7\" stroke=\"#C98A4A\" stroke-width=\"3\" stroke-linecap=\"round\"></path><circle cx=\"82\" cy=\"1\" r=\"3\" fill=\"#C98A4A\"></circle><circle cx=\"93\" cy=\"1\" r=\"3\" fill=\"#C98A4A\"></circle><rect x=\"70\" y=\"18\" width=\"13\" height=\"66\" rx=\"6.5\" fill=\"#F5C98A\" transform=\"rotate(10 76 50)\"></rect><ellipse cx=\"88\" cy=\"16\" rx=\"15\" ry=\"9\" fill=\"#F5C98A\" transform=\"rotate(14 88 16)\"></ellipse><ellipse cx=\"54\" cy=\"92\" rx=\"34\" ry=\"19\" fill=\"#F5C98A\"></ellipse><g fill=\"#F5C98A\"><rect x=\"28\" y=\"100\" width=\"7\" height=\"36\" rx=\"3.5\"></rect><rect x=\"41\" y=\"102\" width=\"7\" height=\"34\" rx=\"3.5\"></rect><rect x=\"62\" y=\"102\" width=\"7\" height=\"34\" rx=\"3.5\"></rect><rect x=\"75\" y=\"100\" width=\"7\" height=\"36\" rx=\"3.5\"></rect></g><g fill=\"#E2A05E\"><circle cx=\"40\" cy=\"86\" r=\"5\"></circle><circle cx=\"56\" cy=\"94\" r=\"6\"></circle><circle cx=\"70\" cy=\"84\" r=\"4.5\"></circle><circle cx=\"30\" cy=\"97\" r=\"3.5\"></circle><circle cx=\"75\" cy=\"58\" r=\"3.5\"></circle><circle cx=\"79\" cy=\"40\" r=\"3\"></circle><circle cx=\"72\" cy=\"72\" r=\"3\"></circle></g><circle cx=\"93\" cy=\"14\" r=\"2\" fill=\"#7A4A20\"></circle><path d=\"M20 90q-8 6-6 16\" stroke=\"#E2A05E\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "0",
      "left": "24px",
      "width": "90px"
    },
    "move": {
      "--p0": "380px",
      "--p1": "120px"
    },
    "cls": "ppi-zoo-swing",
    "float": {},
    "svg": "<svg viewBox=\"0 0 100 170\" width=\"90\" height=\"153\"><path d=\"M50 0v70\" stroke=\"#A9D1B1\" stroke-width=\"4\" stroke-linecap=\"round\"></path><path d=\"M50 20q-12-4-16 4q10 4 16-4zM50 44q12-4 16 4q-10 4-16-4z\" fill=\"#BFE0C5\"></path><path d=\"M50 68q-2 10 0 18\" stroke=\"#C99466\" stroke-width=\"6\" stroke-linecap=\"round\"></path><ellipse cx=\"50\" cy=\"118\" rx=\"20\" ry=\"24\" fill=\"#D9A77A\"></ellipse><ellipse cx=\"50\" cy=\"124\" rx=\"12\" ry=\"14\" fill=\"#F2D3B3\"></ellipse><circle cx=\"50\" cy=\"88\" r=\"17\" fill=\"#D9A77A\"></circle><circle cx=\"33\" cy=\"88\" r=\"6\" fill=\"#E9BE95\"></circle><circle cx=\"67\" cy=\"88\" r=\"6\" fill=\"#E9BE95\"></circle><ellipse cx=\"50\" cy=\"92\" rx=\"11\" ry=\"9\" fill=\"#F2D3B3\"></ellipse><circle cx=\"45\" cy=\"86\" r=\"2\" fill=\"#6B4325\"></circle><circle cx=\"55\" cy=\"86\" r=\"2\" fill=\"#6B4325\"></circle><path d=\"M46 95q4 3 8 0\" stroke=\"#6B4325\" stroke-width=\"1.8\" fill=\"none\" stroke-linecap=\"round\"></path><path d=\"M68 132q20 4 18 22q-2 10-12 6\" stroke=\"#D9A77A\" stroke-width=\"5\" fill=\"none\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "900px",
      "right": "-40px",
      "width": "170px"
    },
    "move": {
      "--p0": "120px",
      "--p1": "-260px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s2",
    "float": {
      "--fx": "-8px",
      "--fr": "2deg"
    },
    "svg": "<svg viewBox=\"0 0 140 110\" width=\"170\" height=\"134\"><ellipse cx=\"78\" cy=\"62\" rx=\"46\" ry=\"32\" fill=\"#E3DDD6\"></ellipse><g fill=\"#E3DDD6\"><rect x=\"50\" y=\"80\" width=\"14\" height=\"26\" rx=\"6\"></rect><rect x=\"70\" y=\"82\" width=\"14\" height=\"24\" rx=\"6\"></rect><rect x=\"92\" y=\"82\" width=\"14\" height=\"24\" rx=\"6\"></rect><rect x=\"110\" y=\"78\" width=\"13\" height=\"28\" rx=\"6\"></rect></g><path d=\"M122 56q12 2 10 16\" stroke=\"#D2CAC1\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\"></path><circle cx=\"40\" cy=\"46\" r=\"26\" fill=\"#E3DDD6\"></circle><ellipse cx=\"56\" cy=\"46\" rx=\"16\" ry=\"21\" fill=\"#D2CAC1\"></ellipse><path d=\"M20 54q-10 18 2 36q4 5 8 1\" stroke=\"#E3DDD6\" stroke-width=\"11\" fill=\"none\" stroke-linecap=\"round\"></path><path d=\"M26 60q-6 4-10 2\" stroke=\"#FFFFFF\" stroke-width=\"3\" stroke-linecap=\"round\"></path><circle cx=\"33\" cy=\"40\" r=\"2.4\" fill=\"#6E6259\"></circle></svg>"
  },
  {
    "place": {
      "top": "1320px",
      "left": "-18px",
      "width": "104px"
    },
    "move": {
      "--p0": "80px",
      "--p1": "-200px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s3",
    "float": {
      "--fx": "10px",
      "--fr": "-5deg"
    },
    "svg": "<svg viewBox=\"0 0 100 120\" width=\"104\" height=\"125\"><path d=\"M44 82q-14 22-6 36M52 84q-6 22 4 34M60 82q6 20 18 28\" stroke=\"#F8B27A\" stroke-width=\"6\" fill=\"none\" stroke-linecap=\"round\"></path><ellipse cx=\"52\" cy=\"60\" rx=\"22\" ry=\"30\" fill=\"#FFD3A8\"></ellipse><path d=\"M62 46q22 14 12 44q-14-6-18-24z\" fill=\"#F8B27A\"></path><circle cx=\"48\" cy=\"30\" r=\"18\" fill=\"#FFD3A8\"></circle><path d=\"M40 14q2-14 14-12q-6 4-4 12zM48 12q8-10 18-4q-8 2-10 8z\" fill=\"#F5C14A\"></path><path d=\"M30 30q-12 2-12 12q10 0 14-6z\" fill=\"#8C7A6B\"></path><circle cx=\"42\" cy=\"27\" r=\"2.6\" fill=\"#4A3A2E\"></circle><ellipse cx=\"52\" cy=\"38\" rx=\"5\" ry=\"3.5\" fill=\"#FBB39A\"></ellipse></svg>"
  },
  {
    "place": {
      "top": "1720px",
      "right": "-30px",
      "width": "136px"
    },
    "move": {
      "--p0": "140px",
      "--p1": "-180px"
    },
    "cls": "ppi-zoo-float",
    "float": {
      "--fx": "-6px",
      "--fr": "4deg"
    },
    "svg": "<svg viewBox=\"0 0 120 120\" width=\"136\" height=\"136\"><circle cx=\"60\" cy=\"60\" r=\"46\" fill=\"#F8B27A\"></circle><g fill=\"#F59E5B\"><circle cx=\"22\" cy=\"46\" r=\"10\"></circle><circle cx=\"98\" cy=\"46\" r=\"10\"></circle><circle cx=\"20\" cy=\"74\" r=\"10\"></circle><circle cx=\"100\" cy=\"74\" r=\"10\"></circle><circle cx=\"40\" cy=\"18\" r=\"10\"></circle><circle cx=\"80\" cy=\"18\" r=\"10\"></circle><circle cx=\"60\" cy=\"12\" r=\"10\"></circle><circle cx=\"42\" cy=\"102\" r=\"10\"></circle><circle cx=\"78\" cy=\"102\" r=\"10\"></circle></g><circle cx=\"38\" cy=\"36\" r=\"8\" fill=\"#FFD9A8\"></circle><circle cx=\"82\" cy=\"36\" r=\"8\" fill=\"#FFD9A8\"></circle><circle cx=\"60\" cy=\"62\" r=\"30\" fill=\"#FFD9A8\"></circle><circle cx=\"49\" cy=\"56\" r=\"3\" fill=\"#6B4325\"></circle><circle cx=\"71\" cy=\"56\" r=\"3\" fill=\"#6B4325\"></circle><path d=\"M54 66h12l-6 6z\" fill=\"#C98A6A\"></path><path d=\"M60 72q-4 6-10 4M60 72q4 6 10 4\" stroke=\"#C98A6A\" stroke-width=\"2\" fill=\"none\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "2140px",
      "left": "-24px",
      "width": "130px"
    },
    "move": {
      "--p0": "100px",
      "--p1": "-160px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s2",
    "float": {
      "--fx": "12px",
      "--fr": "0deg"
    },
    "svg": "<svg viewBox=\"0 0 130 90\" width=\"130\" height=\"90\"><g fill=\"#BFE0C5\"><ellipse cx=\"36\" cy=\"70\" rx=\"9\" ry=\"7\"></ellipse><ellipse cx=\"86\" cy=\"70\" rx=\"9\" ry=\"7\"></ellipse></g><circle cx=\"112\" cy=\"52\" r=\"13\" fill=\"#BFE0C5\"></circle><circle cx=\"116\" cy=\"48\" r=\"2.4\" fill=\"#4E6B54\"></circle><path d=\"M12 64a50 44 0 01100 0z\" fill=\"#A9D1B1\"></path><path d=\"M38 64l6-24h24l6 24M44 40l-12 6M68 40l12 6M56 20v20\" stroke=\"#8CBF97\" stroke-width=\"3\" fill=\"none\" stroke-linejoin=\"round\"></path><path d=\"M14 64q-8 0-10-6\" stroke=\"#BFE0C5\" stroke-width=\"5\" fill=\"none\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "2520px",
      "right": "-26px",
      "width": "140px"
    },
    "move": {
      "--p0": "120px",
      "--p1": "-140px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s3",
    "float": {
      "--fx": "-10px",
      "--fr": "-3deg"
    },
    "svg": "<svg viewBox=\"0 0 130 120\" width=\"140\" height=\"129\"><ellipse cx=\"72\" cy=\"66\" rx=\"40\" ry=\"24\" fill=\"#EFE9E2\"></ellipse><g fill=\"#EFE9E2\"><rect x=\"42\" y=\"80\" width=\"9\" height=\"32\" rx=\"4\"></rect><rect x=\"56\" y=\"82\" width=\"9\" height=\"30\" rx=\"4\"></rect><rect x=\"82\" y=\"82\" width=\"9\" height=\"30\" rx=\"4\"></rect><rect x=\"96\" y=\"80\" width=\"9\" height=\"32\" rx=\"4\"></rect></g><path d=\"M38 58q-4-26-14-34q-8 6-6 16q8 6 10 22z\" fill=\"#EFE9E2\"></path><ellipse cx=\"20\" cy=\"34\" rx=\"10\" ry=\"16\" fill=\"#EFE9E2\" transform=\"rotate(-20 20 34)\"></ellipse><path d=\"M26 20q8 10 12 30\" stroke=\"#CBBFB3\" stroke-width=\"5\" fill=\"none\" stroke-linecap=\"round\"></path><g stroke=\"#CBBFB3\" stroke-width=\"5\" stroke-linecap=\"round\" fill=\"none\"><path d=\"M52 46q-2 14 2 26\"></path><path d=\"M66 43q-3 16 1 30\"></path><path d=\"M80 43q-3 16 1 30\"></path><path d=\"M94 46q-3 14 1 26\"></path></g><path d=\"M112 60q10 4 8 18\" stroke=\"#CBBFB3\" stroke-width=\"3\" fill=\"none\" stroke-linecap=\"round\"></path><circle cx=\"17\" cy=\"30\" r=\"2.2\" fill=\"#6E6259\"></circle></svg>"
  },
  {
    "place": {
      "top": "640px",
      "right": "10px",
      "width": "46px"
    },
    "move": {
      "--p0": "0px",
      "--p1": "-500px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s3",
    "float": {},
    "svg": "<svg viewBox=\"0 0 40 40\" width=\"46\" height=\"46\"><path d=\"M4 36Q6 8 36 4Q34 32 4 36z\" fill=\"#CFE6D2\"></path><path d=\"M6 34L32 8\" stroke=\"#A9D1B1\" stroke-width=\"2\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "1560px",
      "left": "8px",
      "width": "40px"
    },
    "move": {
      "--p0": "0px",
      "--p1": "-420px"
    },
    "cls": "ppi-zoo-float",
    "float": {},
    "svg": "<svg viewBox=\"0 0 40 40\" width=\"40\" height=\"40\"><path d=\"M4 36Q6 8 36 4Q34 32 4 36z\" fill=\"#CFE6D2\"></path><path d=\"M6 34L32 8\" stroke=\"#A9D1B1\" stroke-width=\"2\" stroke-linecap=\"round\"></path></svg>"
  },
  {
    "place": {
      "top": "2380px",
      "right": "16px",
      "width": "36px"
    },
    "move": {
      "--p0": "0px",
      "--p1": "-360px"
    },
    "cls": "ppi-zoo-float ppi-zoo-s2",
    "float": {},
    "svg": "<svg viewBox=\"0 0 40 40\" width=\"36\" height=\"36\"><path d=\"M4 36Q6 8 36 4Q34 32 4 36z\" fill=\"#CFE6D2\"></path><path d=\"M6 34L32 8\" stroke=\"#A9D1B1\" stroke-width=\"2\" stroke-linecap=\"round\"></path></svg>"
  }
];

export function ShopBackdrop() {
  return (
    <div className="ppi-zoo" aria-hidden="true" data-shop-backdrop>
      {ANIMALS.map((a, i) => (
        <div key={i} className="ppi-zoo-animal" style={a.place as CSSProperties}>
          <div className="ppi-zoo-drift" style={a.move as CSSProperties}>
            <div className={a.cls} style={a.float as CSSProperties} dangerouslySetInnerHTML={{ __html: a.svg }} />
          </div>
        </div>
      ))}
    </div>
  );
}
