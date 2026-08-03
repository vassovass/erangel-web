import type { Weapon } from '../weapons/weapon';
import type { Health } from '../player/health';
import type { Match } from '../match/match';
import type { PlayerController } from '../player/controller';

// Playable-base HUD as a DOM overlay (zero GPU cost). The HUD wow-loop
// (stream 11) owns the final PUBG-grade look; keep element ids stable.

export class Hud {
  private ammoEl!: HTMLElement;
  private resEl!: HTMLElement;
  private hpFill!: HTMLElement;
  private reloadEl!: HTMLElement;
  private hitmarker!: HTMLElement;
  private aliveEl!: HTMLElement;
  private killsEl!: HTMLElement;
  private zoneEl!: HTMLElement;
  private feedEl!: HTMLElement;
  private promptEl!: HTMLElement;
  private vignette!: HTMLElement;
  private overlay!: HTMLElement;
  private compassEl!: HTMLElement;
  private hitT = 0;
  private dmgT = 0;
  private feed: { el: HTMLElement; t: number }[] = [];

  constructor(
    private weapon: Weapon,
    private health: Health,
    private match: Match | null,
    private player: PlayerController | null
  ) {
    const root = document.getElementById('hud')!;
    root.innerHTML = `
      <style>
        #hud { position: fixed; inset: 0; pointer-events: none; font-family: 'Segoe UI', system-ui, sans-serif; z-index: 10; }
        #dmgvin { position: absolute; inset: 0; box-shadow: inset 0 0 140px rgba(190,30,20,0.0); transition: box-shadow 0.12s ease; }
        #xhair { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); }
        #xhair .dot { width: 3px; height: 3px; background: rgba(255,255,255,0.92); border-radius: 50%; box-shadow: 0 0 2px rgba(0,0,0,0.8); }
        #hitmk { position: absolute; left: 50%; top: 50%; width: 22px; height: 22px; transform: translate(-50%,-50%) rotate(45deg); opacity: 0; }
        #hitmk span { position: absolute; background: rgba(255,255,255,0.95); box-shadow: 0 0 3px rgba(0,0,0,0.7); }
        #hitmk .t { left: 0; top: 0; width: 7px; height: 2px; } #hitmk .t2 { right: 0; top: 0; width: 7px; height: 2px; }
        #hitmk .b { left: 0; bottom: 0; width: 7px; height: 2px; } #hitmk .b2 { right: 0; bottom: 0; width: 7px; height: 2px; }
        #compass { position: absolute; top: 14px; left: 50%; transform: translateX(-50%); width: 420px; height: 26px;
                   overflow: hidden; color: #dfe6ea; text-shadow: 0 1px 2px rgba(0,0,0,0.8); font-size: 13px; letter-spacing: 1px;
                   -webkit-mask-image: linear-gradient(90deg, transparent, #000 20%, #000 80%, transparent); }
        #compass .strip { position: absolute; top: 3px; white-space: nowrap; }
        #topright { position: absolute; top: 14px; right: 24px; text-align: right; color: #eef2f5; text-shadow: 0 1px 3px rgba(0,0,0,0.85); }
        #topright .alive { font-size: 22px; font-weight: 600; }
        #topright .alive span { font-size: 12px; color: #b8c2c9; font-weight: 400; }
        #topright .kills { font-size: 13px; color: #d9a12b; margin-top: 2px; }
        #zonetimer { position: absolute; top: 52px; left: 50%; transform: translateX(-50%); color: #fff;
                     font-size: 13px; letter-spacing: 2px; text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
        #feed { position: absolute; top: 92px; right: 24px; text-align: right; }
        #feed div { color: #e6ebee; font-size: 12px; text-shadow: 0 1px 2px rgba(0,0,0,0.85);
                    background: rgba(8,10,12,0.45); padding: 3px 8px; margin-top: 4px; border-right: 2px solid #d9a12b; }
        #prompt { position: absolute; left: 50%; bottom: 34%; transform: translateX(-50%); color: #fff; font-size: 14px;
                  background: rgba(8,10,12,0.55); padding: 6px 14px; border: 1px solid rgba(255,255,255,0.25);
                  letter-spacing: 1px; display: none; }
        #prompt b { color: #d9a12b; }
        #ammo { position: absolute; right: 36px; bottom: 30px; color: #f2f5f7; text-shadow: 0 1px 3px rgba(0,0,0,0.8); text-align: right; }
        #ammo .mag { font-size: 34px; font-weight: 600; }
        #ammo .res { font-size: 16px; color: #b8c2c9; }
        #ammo .reload { font-size: 12px; letter-spacing: 2px; color: #d9a12b; height: 16px; }
        #hpwrap { position: absolute; left: 50%; bottom: 26px; transform: translateX(-50%);
                  width: 320px; height: 14px; background: rgba(10,12,14,0.55); border: 1px solid rgba(255,255,255,0.25); }
        #hpfill { height: 100%; width: 100%; background: #e8eef2; transition: width 0.15s ease; }
        #endoverlay { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
                      flex-direction: column; gap: 12px; background: rgba(5,7,9,0.72); pointer-events: none; }
        #endoverlay .big { font-size: 42px; letter-spacing: 6px; color: #f5d67b; font-weight: 300; text-shadow: 0 2px 12px rgba(0,0,0,0.9); }
        #endoverlay .sub { font-size: 15px; color: #cdd6db; letter-spacing: 2px; }
      </style>
      <div id="dmgvin"></div>
      <div id="compass"><div class="strip" id="compassstrip"></div></div>
      <div id="zonetimer"></div>
      <div id="topright"><div class="alive"><span id="alive">16</span> <span>ALIVE</span></div><div class="kills" id="kills"></div></div>
      <div id="feed"></div>
      <div id="xhair"><div class="dot"></div></div>
      <div id="hitmk"><span class="t"></span><span class="t2"></span><span class="b"></span><span class="b2"></span></div>
      <div id="prompt"></div>
      <div id="ammo"><div class="reload" id="reloadtxt"></div><span class="mag" id="mag">30</span> <span class="res" id="res">/ 120</span></div>
      <div id="hpwrap"><div id="hpfill"></div></div>
      <div id="endoverlay"><div class="big" id="endbig"></div><div class="sub" id="endsub"></div></div>
    `;
    this.ammoEl = document.getElementById('mag')!;
    this.resEl = document.getElementById('res')!;
    this.hpFill = document.getElementById('hpfill')!;
    this.reloadEl = document.getElementById('reloadtxt')!;
    this.hitmarker = document.getElementById('hitmk')!;
    this.aliveEl = document.getElementById('alive')!;
    this.killsEl = document.getElementById('kills')!;
    this.zoneEl = document.getElementById('zonetimer')!;
    this.feedEl = document.getElementById('feed')!;
    this.promptEl = document.getElementById('prompt')!;
    this.vignette = document.getElementById('dmgvin')!;
    this.overlay = document.getElementById('endoverlay')!;
    this.compassEl = document.getElementById('compassstrip')!;
    this.buildCompass();
  }

  private buildCompass(): void {
    // 720deg strip: N at 0/360; label every 15deg.
    const parts: string[] = [];
    for (let d = -360; d <= 720; d += 15) {
      const deg = ((d % 360) + 360) % 360;
      const label =
        deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' :
        deg % 45 === 0 ? String(deg) : '·';
      parts.push(`<span style="display:inline-block;width:42px;text-align:center;${label.length === 1 && 'NESW·'.includes(label) && label !== '·' ? 'color:#f5d67b;font-weight:600;' : 'color:#b9c2c8;'}">${label}</span>`);
    }
    this.compassEl.innerHTML = parts.join('');
  }

  showHitmarker(): void {
    this.hitT = 0.25;
  }

  showDamage(): void {
    this.dmgT = 0.6;
  }

  addFeedLine(text: string): void {
    const div = document.createElement('div');
    div.textContent = text;
    this.feedEl.prepend(div);
    this.feed.push({ el: div, t: 6 });
    if (this.feed.length > 5) {
      const old = this.feed.shift()!;
      old.el.remove();
    }
  }

  showEnd(state: 'won' | 'dead', kills: number, alive: number): void {
    this.overlay.style.display = 'flex';
    const big = document.getElementById('endbig')!;
    const sub = document.getElementById('endsub')!;
    if (state === 'won') {
      big.textContent = 'WINNER WINNER CHICKEN DINNER!';
      sub.textContent = `${kills} kills — refresh to drop again`;
    } else {
      big.textContent = 'YOU DIED';
      big.style.color = '#e05a4e';
      sub.textContent = `#${alive} of 16 — ${kills} kills — refresh to drop again`;
    }
  }

  update(dt: number): void {
    this.ammoEl.textContent = String(this.weapon.ammo);
    this.resEl.textContent = `/ ${this.weapon.reserve}`;
    this.hpFill.style.width = `${this.health.hp}%`;
    this.hpFill.style.background = this.health.hp > 50 ? '#e8eef2' : this.health.hp > 25 ? '#d9a12b' : '#e05a4e';
    this.reloadEl.textContent = this.weapon.phase === 'reloading' ? 'RELOADING' : '';

    if (this.hitT > 0) {
      this.hitT -= dt;
      this.hitmarker.style.opacity = String(Math.max(0, Math.min(1, this.hitT * 8)));
    }
    if (this.dmgT > 0) {
      this.dmgT -= dt;
      this.vignette.style.boxShadow = `inset 0 0 140px rgba(190,30,20,${(this.dmgT * 0.75).toFixed(2)})`;
    }

    if (this.player) {
      // Compass: yaw 0 = -Z = North.
      const deg = ((-this.player.yaw * 180) / Math.PI + 360) % 360;
      const px = -((deg + 360) / 15) * 42 + 210 - 21;
      this.compassEl.style.transform = `translateX(${px}px)`;
    }

    if (this.match) {
      this.aliveEl.textContent = String(this.match.aliveCount);
      this.killsEl.textContent = this.match.kills > 0 ? `${this.match.kills} KILLS` : '';
      const z = this.match.zone;
      if (z.finished) {
        this.zoneEl.textContent = 'FINAL CIRCLE';
      } else if (z.isShrinking) {
        this.zoneEl.textContent = 'ZONE SHRINKING';
        this.zoneEl.style.color = '#7fb2ff';
      } else {
        const cd = Math.ceil(z.countdown);
        this.zoneEl.textContent = `ZONE ${Math.floor(cd / 60)}:${String(cd % 60).padStart(2, '0')}`;
        this.zoneEl.style.color = '#fff';
      }

      const item = this.match.lootInReach();
      if (item && this.match.state === 'playing') {
        const label = item.type === 'ammo' ? '30 Ammo' : item.type === 'medkit' ? 'Medkit' : 'Bandage';
        this.promptEl.innerHTML = `<b>F</b> — Pick up ${label}`;
        this.promptEl.style.display = 'block';
      } else {
        this.promptEl.style.display = 'none';
      }
    }

    for (let i = this.feed.length - 1; i >= 0; i--) {
      this.feed[i].t -= dt;
      if (this.feed[i].t <= 0) {
        this.feed[i].el.remove();
        this.feed.splice(i, 1);
      }
    }
  }
}
