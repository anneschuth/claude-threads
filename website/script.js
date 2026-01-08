// Copy install command to clipboard
function copyInstall() {
  const cmd = document.getElementById('install-cmd').textContent;
  navigator.clipboard.writeText(cmd).then(() => {
    const btn = document.querySelector('.copy-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.style.color = '#a78bfa';
    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.style.color = '';
    }, 2000);
  });
}

// Smooth scroll for anchor links (fallback for older browsers)
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth' });
    }
  });
});
