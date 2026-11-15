const button = document.querySelector('#activate-account');
const status = document.querySelector('#bootstrap-status');

button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Activando tu cuenta…';
  try {
    const response = await fetch('/api/admin/bootstrap', {
      method: 'POST',
      headers: { accept: 'application/json' }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No se pudo activar la cuenta.');
    status.textContent = 'Cuenta configurada. Abriendo el panel…';
    window.location.assign('/admin/');
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});
