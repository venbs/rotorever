"""Plot the deterministic maneuver benchmark; requires matplotlib, no flight files."""
import json
import pathlib
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else "analysis/maneuver-loads")
destination.mkdir(parents=True, exist_ok=True)
report = json.loads(source.read_text())
(destination / "results.json").write_text(json.dumps(report, indent=2) + "\n")
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False, "axes.labelcolor": "#334155", "text.color": "#0f172a"})
fig, axes = plt.subplots(1, 2, figsize=(12, 4.8), layout="constrained")
fig.suptitle("Collective + cyclic: added blade loading", fontsize=17, fontweight="bold")
for collective, color in [(0, "#b1bdcb"), (6, "#6b8097"), (12, "#0969da")]:
    rows = [r for r in report["surface"] if r["collective"] == collective]
    axes[0].plot([r["cyclic"] for r in rows], [r["torque"] for r in rows], "o-", color=color,
                 label=f"Collective {collective}°", linewidth=2)
axes[0].set(title="Fixed airflow / 2400 RPM", xlabel="Effective cyclic amplitude (°)", ylabel="Main rotor shaft load (N·m)")
axes[0].text(.03, .95, "Zero aircraft speed; uniform inflow 4 m/s\nSampled, steady separation state", transform=axes[0].transAxes,
             va="top", fontsize=9, color="#64748b")
axes[0].set_ylim(0, 24)
axes[0].legend(loc="upper left", bbox_to_anchor=(0, .80), frameon=False)
for enabled, cyclic, label, color, style in [
    (True, 0, "Collective only", "#a7b1be", ":"),
    (False, 1, "Collective + elevator, old", "#475569", "--"),
    (True, 1, "Collective + elevator, new", "#0969da", "-"),
]:
    case = next(c for c in report["cases"] if c["motor"] == 90 and c["collective"] == 1
                and c["cyclic"] == cyclic and c["axis"] == "pitch" and c["enabled"] == enabled)
    rows = case["traces"]
    axes[1].plot([r["time"] for r in rows], [r["rpm"] for r in rows], linestyle=style,
                 color=color, linewidth=2, label=f'{label}\nMin {case["minimumRPM"]:.0f} RPM')
axes[1].axvspan(.2, 1.2, color="#0969da", alpha=.06)
axes[1].set(title="Free flight / 90% finite motor", xlabel="Time (s)", ylabel="Head speed (RPM)")
axes[1].text(.03, .97, "5 kg · ±12° · 350°/s\nFull inputs 0.2–1.2 s, then unload", transform=axes[1].transAxes,
             va="top", fontsize=9, color="#64748b")
axes[1].legend(loc="lower right", fontsize=8, frameon=False)
for ax in axes:
    ax.grid(alpha=.12)
fig.supxlabel("Provisional reduced-order model. These are model comparisons, not measured HELI-X or real-flight results.",
               fontsize=9, color="#64748b")
fig.savefig(destination / "comparison.png", dpi=170)
fig.savefig(destination / "comparison.svg")
plt.close(fig)
print(destination / "comparison.png")
