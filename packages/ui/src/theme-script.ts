// Runs inline in <head> before first paint, so a stored light or dark choice applies with no
// flash. Without a stored choice, or with JS off, the stylesheet follows the system. The text
// never changes, so one CSP hash covers it everywhere.
export const themeStorageKey = 'dr-theme';

export const themeScript =
  'try{var t=localStorage.getItem("dr-theme");if(t=="light"||t=="dark")document.documentElement.dataset.theme=t}catch(e){}';
