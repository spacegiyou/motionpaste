const source = document.querySelector("#source-card");
const kind = document.querySelector("#motion-kind");
function restart() {
  source.getAnimations().forEach((animation) => animation.cancel());
  source.style.animation = "none";
  void source.offsetWidth;
  if (kind.value === "css") {
    source.style.animation = "";
  } else if (kind.value === "waapi") {
    source.animate(
      [
        { offset: 0, transform: "translateX(-45px) scale(0.88)", opacity: 0 },
        {
          offset: 0.6,
          transform: "translateX(8px) scale(1.04)",
          opacity: 0.95,
        },
        { offset: 1, transform: "translateX(0px) scale(1)", opacity: 1 },
      ],
      { duration: 1600, easing: "ease-in-out", fill: "both" },
    );
  } else {
    source.animate(
      [{ backgroundColor: "#214b3a" }, { backgroundColor: "#c74633" }],
      { duration: 1500, fill: "both" },
    );
  }
}
document.querySelector("#restart").addEventListener("click", restart);
kind.addEventListener("change", restart);
