// §0 Hero: answer line, meta chips and the four verdict cards.
import { el, fill, keyOf } from './dom.js?v=20260912';
import { createCopy } from '../copy.js?v=20260912';
import { mountPoint, statusLine, applyStatus, robustReady } from './common.js?v=20260912';

function cardShell(api) {
  const eyebrow = el('h3', { class: 'card__eyebrow' });
  const value = el('p', { class: 'card__value' }, ['—']);
  const lines = el('div', { class: 'hero-card__lines' });
  const small = el('p', { class: 'card__line hero-card__small', hidden: true });
  const prov = el('span', { class: 'hero-card__prov' });
  const link = el('button', { type: 'button', class: 'btn btn--ghost hero-card__link' }, ['依据 ↓']);
  let target = null;
  link.addEventListener('click', () => target && api.scrollTo(target));
  const root = el('article', { class: 'card hero-card' }, [eyebrow, value, lines, small, el('div', { class: 'hero-card__foot' }, [prov, link])]);
  return {
    root,
    set(c) {
      target = c.target;
      fill(eyebrow, c.eyebrow);
      fill(value, c.big);
      fill(lines, c.lines.map((segs) => el('p', { class: 'card__line' }, segs)));
      small.hidden = !c.small;
      fill(small, c.small ?? []);
      fill(prov, (c.prov ?? []).map((t) => el('span', { class: 'chip chip--prov' }, [t])));
    },
    wait(eyebrowText) {
      fill(eyebrow, eyebrowText);
      fill(value, ['—']);
      fill(lines, [el('p', { class: 'card__line' }, ['计算中…'])]);
      small.hidden = true;
    },
  };
}

const EYEBROWS = ['风险调整后谁更好', '纳指100 优势能持续吗', '超额从哪来', '同波动下怎么配'];

export function mount(rootEl, api) {
  const C = createCopy(api.format);
  const host = mountPoint(rootEl);
  const answer = el('p', { class: 'hero__answer' });
  const meta = el('p', { class: 'hero__meta' });
  const status = statusLine();
  const cards = EYEBROWS.map(() => cardShell(api));
  host.appendChild(answer);
  host.appendChild(meta);
  host.appendChild(status);
  host.appendChild(el('div', { class: 'hero__cards grid-2' }, cards.map((c) => c.root)));
  cards.forEach((c, i) => c.wait(EYEBROWS[i]));
  let sig = '';

  const safe = (card, i, build) => {
    try { card.set(build()); } catch (err) {
      console.warn('hero card', i, err);
      card.wait(EYEBROWS[i]);
    }
  };

  return {
    render(view) {
      applyStatus(host, status, view, ['sample', 'context', 'alloc']);
      const { sample, context, alloc } = view.bundles;
      // card 4's out-of-sample line never pairs this state's labels with a previous robust job's numbers
      const robust = robustReady(view);
      const failed = !!view.errors?.robust;
      const s = view.state;
      const next = [keyOf(sample), keyOf(context), keyOf(alloc), keyOf(robust), !!robust, failed, s.wfWindow, s.wht, s.volMult].join('|');
      if (next === sig) return;
      sig = next;
      if (sample) {
        fill(answer, C.heroAnswer(sample));
        const m = C.heroMeta(sample, s);
        // One flex item for the line (the date range never breaks) and one text run per chip.
        fill(meta, [el('span', { class: 'hero__meta-line' }, [el('span', { class: 'nowrap' }, m.range), m.rest]),
          ...m.chips.map((c) => el('span', { class: c.cls, title: c.title }, [el('span', {}, c.text)]))]);
        safe(cards[0], 0, () => C.card1(sample));
      }
      if (context) {
        safe(cards[1], 1, () => C.card2(context));
        safe(cards[2], 2, () => C.card3(context));
      }
      if (alloc) safe(cards[3], 3, () => C.card4(alloc, robust, s, failed));
    },
  };
}
