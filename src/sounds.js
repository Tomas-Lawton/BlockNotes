export function playPop() {
    chrome.storage.local.get("settings", (data) => {
        const settings = data.settings || {};
        if (settings.playSounds === false) return;
        const audio = new Audio('./public/audio/pop.mp3');
        audio.play();
    });
}