// Copy buttons: put the command on the clipboard and say so on the button and to screen
// readers. Where the browser refuses the clipboard, select the command so it can be copied
// by hand.

const status = document.getElementById('copy-status');

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const text = button.dataset.copy;
    try {
      await navigator.clipboard.writeText(text);
      announce(button, 'Copied', `Copied ${text} to the clipboard`);
    } catch {
      selectCommand(button);
      announce(button, 'Selected', `Selected ${text}; copy it with your keyboard`);
    }
  });
}

function selectCommand(button) {
  const code = button.parentElement.querySelector('code');
  if (!code) return;
  const range = document.createRange();
  range.selectNodeContents(code);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function announce(button, label, message) {
  const original = button.dataset.label ?? button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  button.disabled = true;
  if (status) status.textContent = message;
  setTimeout(() => {
    button.textContent = original;
    button.disabled = false;
  }, 1600);
}

// Section tabs: the square on a section's tab fills while that section crosses the middle of the
// screen. A band 1% of the screen tall across the middle does it without a scroll listener;
// without the observer the tabs stay as drawn.

if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        entry.target.querySelector('.kicker')?.classList.toggle('is-current', entry.isIntersecting);
      }
    },
    { rootMargin: '-49% 0px -50% 0px' },
  );
  for (const tab of document.querySelectorAll('.kicker')) {
    const section = tab.closest('section');
    if (section) observer.observe(section);
  }
}

// The first screen replays a recorded run once it comes into view: the command is typed, the
// report comes line by line, the page it wrote appears, a yes is typed, and the page after the
// fix takes its place. Until then it shows its first frame. Without the observer, or when less
// motion is asked for, the last scene stands as the page is written.

const demo = document.querySelector('[data-demo]');
const prefersLessMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const canPlay = 'IntersectionObserver' in window && !prefersLessMotion;

// The last scene: the end of the run in the terminal, beside the page after the fix.
if (demo && !canPlay) {
  const scroller = demo.querySelector('.demo-scroll');
  scroller.scrollTop = scroller.scrollHeight;
}

if (demo && canPlay) {
  const lines = [...demo.querySelectorAll('.demo-line')];
  const steps = [...demo.querySelectorAll('.demo-steps li')];
  const scroller = demo.querySelector('.demo-scroll');
  const typed = demo.querySelector('.demo-typed');
  const answer = demo.querySelector('.demo-answer');
  const replay = demo.querySelector('.demo-replay');
  const command = typed.textContent;
  let run = 0;

  // Each wait says whether its run is still the one playing, so that a replay stops the one before.
  const wait = (ms, id) => new Promise((resolve) => setTimeout(() => resolve(id === run), ms));
  const reach = (step) => steps.forEach((item, index) => item.classList.toggle('is-reached', index < step));
  const show = (element) => {
    element.classList.add('is-shown');
    scroller.scrollTop = scroller.scrollHeight;
  };

  async function showLines(beat, id) {
    for (const line of lines.filter((item) => item.dataset.beat === beat && !item.contains(typed))) {
      show(line);
      if (!(await wait(45, id))) return false;
    }
    return true;
  }

  // The first frame: the prompt alone, no page and no step past the first.
  function reset() {
    demo.classList.remove('has-page', 'is-fixed');
    demo.classList.add('is-playing');
    for (const element of [...lines, answer]) element.classList.remove('is-shown');
    reach(1);
    typed.textContent = '';
    show(lines[0]);
  }

  async function play() {
    const id = ++run;
    reset();
    for (const character of command) {
      if (!(await wait(70, id))) return;
      typed.textContent += character;
    }
    if (!(await wait(500, id)) || !(await showLines('1', id)) || !(await wait(500, id))) return;
    demo.classList.add('has-page');
    reach(2);
    if (!(await wait(2600, id))) return;
    reach(3);
    if (!(await showLines('2', id)) || !(await wait(1000, id))) return;
    show(answer);
    if (!(await wait(600, id)) || !(await showLines('3', id)) || !(await wait(300, id))) return;
    demo.classList.add('is-fixed');
    reach(4);
    if (!(await wait(900, id))) return;
    // From the first end on, "Play again" stays where it is, and so does a keyboard user on it.
    demo.classList.add('has-played');
  }

  reset();
  replay.addEventListener('click', play);
  // It starts once its top is above the lowest 30% of the screen, which a screen of any height
  // reaches; a share of the demo in view would be out of reach on a short screen.
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      play();
    },
    { rootMargin: '0px 0px -30% 0px' },
  );
  observer.observe(demo);
}

// The npm download count, written into the page when it is published, counts up from zero once it
// comes into view. Screen readers get the number from its own hidden copy. Without the observer,
// or when less motion is asked for, it stands as written.

const COUNT_MS = 1200;
const count = document.querySelector('[data-downloads]:not([hidden]) [data-count]');

if (count && 'IntersectionObserver' in window && !prefersLessMotion) {
  const target = Number(count.dataset.count);
  count.textContent = '0';
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      const start = performance.now();
      const step = (now) => {
        const progress = Math.min(1, (now - start) / COUNT_MS);
        // Fast at first and slowing into the number, as a counter settles.
        count.textContent = Math.round(target * (1 - (1 - progress) ** 3)).toLocaleString('en-US');
        if (progress < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    { rootMargin: '0px 0px -20% 0px' },
  );
  observer.observe(count);
}
