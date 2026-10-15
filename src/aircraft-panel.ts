import { copyFbl, defaultErrorRotation, errorRotationBounds, fblAxes, filterBounds, filterKeys, gainBounds, gainKeys } from './physics/fbl.ts';
import { aerodynamicKeys, defaultAircraft, aircraftBounds, aircraftStorageKey, validAircraft, type AircraftProfile } from './aircraft-settings.ts';
import type { MappedInput, ProfileStorage } from './gamepad.ts';
import { RateCurves } from './rate-curves.ts';

const axisNames = { roll: '横滚', pitch: '俯仰', yaw: '尾舵' };
const gainNames = { p: 'P', i: 'I', d: 'D', ff: 'FF %', b: 'B %' };
const filterNames = { dCutoff: 'D 滤波', bCutoff: 'B 滤波', relaxCutoff: 'I Relax' };
type TabName = 'airframe' | 'flight' | 'rates';
const tabs: [TabName, string][] = [['airframe', '机体参数'], ['flight', '飞行参数'], ['rates', '速率设置']];

export class AircraftPanel {
  readonly dialog: HTMLDialogElement;
  private profile: AircraftProfile;
  private rateCurves: RateCurves;
  constructor(profile: AircraftProfile, storage: ProfileStorage | null, onApply: (profile: AircraftProfile) => void, onOpen: () => void) {
    this.profile = structuredClone(profile);
    const dialog = this.dialog = document.createElement('dialog');
    dialog.id = 'aircraft-dialog'; dialog.setAttribute('aria-labelledby', 'aircraft-title');
    const numberField = (key: keyof typeof aircraftBounds, label: string, unit: string, note = '') => {
      const b = aircraftBounds[key];
      return `<label class="setting-field" for="aircraft-${key}"><span>${label}</span><div class="field-value"><input id="aircraft-${key}" type="number" min="${b.min}" max="${b.max}" step="${b.step}" required /><span>${unit}</span></div>${note ? `<small>${note}</small>` : ''}</label>`;
    };
    dialog.innerHTML = `
      <div class="dialog-head"><div><span class="eyebrow">AIRCRAFT / CONFIGURATION</span><h1 id="aircraft-title">机体设置</h1></div><button class="icon-button" id="aircraft-close" aria-label="关闭机体设置">×</button></div>
      <div class="setting-tabs" role="tablist" aria-label="机体设置分类">${tabs.map(([key, label]) => `<button id="tab-${key}" role="tab" aria-controls="panel-${key}" aria-selected="${key === 'airframe'}" tabindex="${key === 'airframe' ? 0 : -1}">${label}</button>`).join('')}</div>
      <form id="aircraft-form" novalidate>
        <div class="settings-content">
          <section id="panel-airframe" role="tabpanel" aria-labelledby="tab-airframe">
            <div class="section-caption"><span>01 / AIRFRAME</span><span>动力与质量</span></div>
            <div class="setting-grid">${numberField('mass', '起飞重量', 'kg', '同样推力下，重量越小，加速度越大。')}${numberField('rpm', '定速转速', 'RPM')}</div>
            <p class="setting-note">起飞重量包含电池。定速器维持设定转速，总距独立控制升力。</p>
            <div class="aerodynamics-setting">
              <div class="section-caption"><span>气动响应</span><button type="button" class="text-button" id="aerodynamics-defaults">恢复气动默认</button></div>
              <div class="setting-grid aerodynamic-grid">
                ${numberField('liftGain', '总距升力增益', '%', '同转速、同螺距下，调高会增加推力和动力负载。')}
                ${numberField('axialDamping', '旋翼轴向阻尼', '%', '调低会减小沿桨轴运动的阻力，也会减弱制动。')}
                ${numberField('bodyDrag', '机身空气阻力', '%', '影响机身各方向的平移阻力，不改变旋翼阻尼。')}
              </div>
              <p class="setting-note">100% 为当前基准。先每次只调整一项，再点击应用设置试飞。</p>
            </div>
            <div class="motor-setting">
              <div class="motor-setting-head"><label for="aircraft-motorTorque">电机扭矩</label><output id="motor-torque-value" for="aircraft-motorTorque"></output></div>
              <input id="aircraft-motorTorque" type="range" min="${aircraftBounds.motorTorque.min}" max="${aircraftBounds.motorTorque.max}" step="${aircraftBounds.motorTorque.step}" aria-describedby="motor-torque-note" />
              <div class="motor-setting-scale" aria-hidden="true"><span>低</span><span>最大 · 不掉转</span></div>
              <p id="motor-torque-note" class="setting-note">数值越高，动力越强。最大档启用理想定速，启动完成后不随总距负载掉转。</p>
            </div>
          </section>
          <section id="panel-flight" role="tabpanel" aria-labelledby="tab-flight" hidden>
            <div class="section-caption"><span>02 / FLIGHT CONTROL</span><button type="button" class="text-button" id="fbl-defaults">恢复飞控默认</button></div>
            <div class="fbl-table-wrap"><table class="fbl-table"><thead><tr><th scope="col">轴</th>${gainKeys.map(key => `<th scope="col">${gainNames[key]}</th>`).join('')}</tr></thead><tbody>${fblAxes.map(axis => `<tr><th scope="row">${axisNames[axis]}</th>${gainKeys.map(key => {
              const b = gainBounds[key];
              return `<td><input id="fbl-${axis}-${key}" aria-label="${axisNames[axis]} ${gainNames[key]}" type="number" min="${b.min}" max="${b.max}" step="${b.step}" required /></td>`;
            }).join('')}</tr>`).join('')}</tbody></table></div>
            <p class="setting-note">P 跟随 · I 消除偏差 · D 抑制回弹<br>FF 持续速率前馈 · B 打杆与换向加速</p>
            <div class="piro-setting">
              <div class="section-caption"><span>自旋优化</span><button type="button" class="text-button" id="piro-defaults">恢复自旋默认</button></div>
              <div class="setting-grid">
                <label class="setting-field" for="fbl-errorRotation"><span>误差旋转</span><span class="piro-toggle"><input id="fbl-errorRotation" type="checkbox" aria-describedby="piro-note" /><span>开启自旋补偿</span></span><small>推荐开启，帮助自旋时保持姿态。</small></label>
                <label class="setting-field" for="fbl-errorRotationGain"><span>补偿比例</span><div class="field-value"><input id="fbl-errorRotationGain" type="number" min="${errorRotationBounds.min}" max="${errorRotationBounds.max}" step="${errorRotationBounds.step}" required aria-describedby="piro-note" /><span>%</span></div><small>RF 参考值 100%；每次调整 5% 试飞。</small></label>
              </div>
              <p id="piro-note" class="setting-note">100% 按实际自旋角度完整补偿横滚与俯仰误差。低于 100% 减少补偿，高于 100% 增加补偿；关闭或设为 0% 时不补偿。</p>
            </div>
            <details class="fbl-advanced"><summary>滤波设置</summary><div class="setting-grid three">${filterKeys.map(key => `<label class="setting-field" for="fbl-${key}"><span>${filterNames[key]}</span><div class="field-value"><input id="fbl-${key}" type="number" min="${filterBounds.min}" max="${filterBounds.max}" step="1" required /><span>Hz</span></div></label>`).join('')}</div><p class="setting-note">参数采用本模拟器尺度，不能直接照搬真实飞控。P 为 s⁻¹，I 为 s⁻²，D 为无量纲；FF / B 为百分比。</p></details>
          </section>
          <section id="panel-rates" role="tabpanel" aria-labelledby="tab-rates" hidden>
            <div class="rates-layout">
              <div class="rates-parameters">
                <div class="section-caption"><span>03 / RATES & PITCH</span><span>常规 Expo</span></div>
                <div class="setting-grid">${numberField('cyclic', '横滚 / 俯仰', '°/s')}${numberField('yaw', '尾舵', '°/s')}${numberField('expo', 'Expo', '%')}${numberField('pitch', '集体螺距', '± °')}</div>
                <p class="setting-note">Expo 柔化中杆，满杆速率不变。<br>集体螺距线性输出，不受 Expo 影响。</p>
              </div>
              <div class="rates-curves"></div>
            </div>
          </section>
        </div>
        <footer class="dialog-footer"><span id="aircraft-message" role="status">设置保存在本机</span><button type="submit" class="primary">应用设置 <span aria-hidden="true">↗</span></button></footer>
      </form>`;
    document.body.append(dialog);
    this.rateCurves = new RateCurves(dialog.querySelector('.rates-curves')!);
    for (const key of ['cyclic', 'yaw', 'expo', 'pitch']) this.field(`aircraft-${key}`).addEventListener('input', () => this.updateRateCurves());
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    this.field('aircraft-motorTorque').oninput = () => this.updateMotorTorque();
    dialog.querySelector<HTMLButtonElement>('#aircraft-close')!.onclick = () => dialog.close();
    tabs.forEach(([key], index) => {
      const tab = dialog.querySelector<HTMLButtonElement>(`#tab-${key}`)!;
      tab.onclick = () => this.selectTab(key);
      tab.onkeydown = e => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowRight' ? 1 : -1) + 3) % 3;
        this.selectTab(tabs[next][0]); dialog.querySelector<HTMLButtonElement>(`#tab-${tabs[next][0]}`)!.focus();
      };
    });
    dialog.querySelector<HTMLButtonElement>('#fbl-defaults')!.onclick = () => {
      this.fillFbl(defaultAircraft().fbl); this.message('飞控默认已填入，点击应用设置后生效');
    };
    dialog.querySelector<HTMLButtonElement>('#piro-defaults')!.onclick = () => {
      this.fillErrorRotation(defaultErrorRotation()); this.message('自旋默认已填入，点击应用设置后生效');
    };
    dialog.querySelector<HTMLButtonElement>('#aerodynamics-defaults')!.onclick = () => {
      this.fillAerodynamics(defaultAircraft().aerodynamics); this.message('气动默认已填入，点击应用设置后生效');
    };
    form.onsubmit = e => {
      e.preventDefault();
      const invalid = [...form.querySelectorAll<HTMLInputElement>('input')].find(field => !field.validity.valid);
      if (invalid) {
        const section = invalid.closest('section')!.id.replace('panel-', '') as TabName;
        this.selectTab(section); invalid.closest('details')?.setAttribute('open', ''); invalid.reportValidity(); return;
      }
      const draft: AircraftProfile = {
        mass: this.value('aircraft-mass'), rpm: this.value('aircraft-rpm'), motorTorque: this.value('aircraft-motorTorque'), pitch: this.value('aircraft-pitch'),
        rates: { cyclic: this.value('aircraft-cyclic'), yaw: this.value('aircraft-yaw'), expo: this.value('aircraft-expo') / 100 },
        fbl: copyFbl(this.profile.fbl),
        aerodynamics: { liftGain: this.value('aircraft-liftGain'), axialDamping: this.value('aircraft-axialDamping'), bodyDrag: this.value('aircraft-bodyDrag') },
      };
      for (const axis of fblAxes) for (const key of gainKeys) draft.fbl[axis][key] = this.value(`fbl-${axis}-${key}`);
      for (const key of filterKeys) draft.fbl[key] = this.value(`fbl-${key}`);
      draft.fbl.errorRotation = this.field('fbl-errorRotation').checked;
      draft.fbl.errorRotationGain = this.value('fbl-errorRotationGain');
      if (!validAircraft(draft)) { this.message('请检查参数范围'); return; }
      this.profile = structuredClone(draft); onApply(draft);
      let saved = false;
      try { if (storage) { storage.setItem(aircraftStorageKey, JSON.stringify(draft)); saved = true; } } catch { /* Current session works. */ }
      this.message(saved ? '已应用并保存' : '已应用 · 本次会话有效');
    };
    document.getElementById('aircraft-settings')!.onclick = () => {
      onOpen(); this.fill(); this.message('设置保存在本机'); dialog.showModal();
    };
  }
  updateInput(input: MappedInput | null) {
    if (this.dialog.open && this.dialog.dataset.activeTab === 'rates') this.rateCurves.updateInput(input);
  }
  private selectTab(key: TabName) {
    this.dialog.dataset.activeTab = key;
    for (const [name] of tabs) {
      const selected = name === key, button = this.dialog.querySelector<HTMLButtonElement>(`#tab-${name}`)!;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      this.dialog.querySelector<HTMLElement>(`#panel-${name}`)!.hidden = !selected;
    }
  }
  private field(id: string) { return this.dialog.querySelector<HTMLInputElement>(`#${id}`)!; }
  private value(id: string) { return this.field(id).valueAsNumber; }
  private fillFbl(profile: AircraftProfile['fbl']) {
    for (const axis of fblAxes) for (const key of gainKeys) this.field(`fbl-${axis}-${key}`).value = String(profile[axis][key]);
    for (const key of filterKeys) this.field(`fbl-${key}`).value = String(profile[key]);
    this.fillErrorRotation(profile);
  }
  private fillErrorRotation(profile: ReturnType<typeof defaultErrorRotation>) {
    this.field('fbl-errorRotation').checked = profile.errorRotation;
    this.field('fbl-errorRotationGain').value = String(profile.errorRotationGain);
  }
  private fillAerodynamics(profile: AircraftProfile['aerodynamics']) {
    for (const key of aerodynamicKeys) this.field(`aircraft-${key}`).value = String(profile[key]);
  }
  private fill() {
    const p = this.profile;
    for (const key of ['mass', 'rpm', 'motorTorque', 'pitch'] as const) this.field(`aircraft-${key}`).value = String(p[key]);
    this.updateMotorTorque();
    this.fillAerodynamics(p.aerodynamics);
    this.field('aircraft-cyclic').value = String(p.rates.cyclic); this.field('aircraft-yaw').value = String(p.rates.yaw);
    this.field('aircraft-expo').value = String(p.rates.expo * 100); this.fillFbl(p.fbl);
    this.updateRateCurves();
  }
  private updateRateCurves() {
    const valid = ['cyclic', 'yaw', 'expo', 'pitch'].every(key => this.field(`aircraft-${key}`).validity.valid);
    this.rateCurves.update(valid ? {
      rates: { cyclic: this.value('aircraft-cyclic'), yaw: this.value('aircraft-yaw'), expo: this.value('aircraft-expo') / 100 },
      pitch: this.value('aircraft-pitch'),
    } : null);
  }
  private updateMotorTorque() {
    const value = this.value('aircraft-motorTorque');
    const text = value === 100 ? '最大 · 理想定速' : `${value}%`;
    this.dialog.querySelector('#motor-torque-value')!.textContent = text;
    this.field('aircraft-motorTorque').setAttribute('aria-valuetext', text);
  }
  private message(text: string) { this.dialog.querySelector('#aircraft-message')!.textContent = text; }
}
