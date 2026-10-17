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
