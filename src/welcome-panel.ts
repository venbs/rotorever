import { release, WelcomeState } from './release.ts';

export class WelcomePanel {
  readonly dialog: HTMLDialogElement;
  private onOpen: () => void;
  constructor(state: WelcomeState, onOpen: () => void, onController: () => void) {
    this.onOpen = onOpen;
    const dialog = this.dialog = document.createElement('dialog');
    dialog.id = 'welcome-dialog'; dialog.setAttribute('aria-labelledby', 'welcome-title');
    dialog.innerHTML = `
      <header class="dialog-head"><div><span class="eyebrow">ROTOREVER / READY TO FLY</span><h2 id="welcome-title">欢迎来到飞场</h2></div><button aria-label="关闭欢迎介绍">×</button></header>
      <div class="welcome-body"><p class="welcome-lead">默认设置已就绪，拖动下方摇杆即可试飞。<br>更多设置，都在右上角 <b>MENU</b>。</p>
        <ol class="welcome-steps">
          <li><span>01</span><div><strong>遥控器设置</strong><p>连接 USB 遥控器，选好通道并校准。</p></div></li>
          <li><span>02</span><div><strong>机体设置</strong><p>调整重量、转速和操控手感。</p></div></li>
          <li><span>03</span><div><strong>飞场设置</strong><p>喜欢哪张地图，下载后就能切换。</p></div></li>
        </ol>
        <section class="release-notes" aria-labelledby="release-title"><div><h3 id="release-title">本次更新</h3><span>v${release.version}</span></div><ul>${release.features.map(text => `<li>${text}</li>`).join('')}</ul></section>
      </div>
      <footer class="dialog-footer"><button class="text-button welcome-controller">先设置遥控器</button><button class="primary welcome-start" autofocus>开始体验 <span aria-hidden="true">↗</span></button></footer>`;
    document.body.append(dialog);
    dialog.querySelector<HTMLButtonElement>('.dialog-head button')!.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>('.welcome-start')!.onclick = () => dialog.close();
    dialog.querySelector<HTMLButtonElement>('.welcome-controller')!.onclick = () => { dialog.close(); onController(); };
    dialog.addEventListener('close', () => state.complete());
    if (state.firstRun) this.open();
  }
  open() { this.onOpen(); this.dialog.showModal(); }
}
