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
