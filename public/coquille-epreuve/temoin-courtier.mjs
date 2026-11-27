// Le TÉMOIN du courtier (#341) : il encadre la page hostile, servie par l'hébergeur et non par le
// relais, en lui passant l'origine tierce. Aucune politique, aucun Service Worker.

const cadre = document.createElement("iframe");
cadre.id = "application-servie";
cadre.src = `sorties-hostiles.html${location.search}`;
document.querySelector("#emplacement").append(cadre);
