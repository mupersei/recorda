// 최소 DOM 가짜 (팝업·설정 페이지 컨트롤러 단위 테스트용): 요소의 classList / hidden / textContent / dataset / 이벤트,
// select의 option 목록과 value 동작(비활성 option도 코드로는 고를 수 있음, 없는 값이면 선택 없음)만 흉내 냅니다.

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach(n => this.set.add(n)); }
  remove(...names) { names.forEach(n => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  toString() { return [...this.set].join(' '); }
}

export class FakeElement {
  constructor(tagName = 'div', { id = '', textContent = '', className = '' } = {}) {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.textContent = textContent;
    this.classList = new FakeClassList();
    if (className) this.className = className;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this.hidden = false;
    this.disabled = false;
    this.title = '';
    this.children = [];
    this.listeners = {};
    this.ownerDocument = fakeDocument;
  }
  get className() { return this.classList.toString(); }
  set className(value) { this.classList = new FakeClassList(); String(value).split(/\s+/).filter(Boolean).forEach(n => this.classList.add(n)); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
  /** 리스너를 부르고, 비동기 리스너의 Promise를 모두 기다릴 수 있게 돌려줌 */
  dispatchEvent(event) {
    const evt = typeof event === 'string' ? { type: event } : event;
    evt.target = evt.target || this;
    return Promise.all((this.listeners[evt.type] || []).map(fn => fn(evt)));
  }
  click() { return this.disabled ? Promise.resolve([]) : this.dispatchEvent({ type: 'click' }); }
  appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
  replaceChildren(...nodes) { this.children = []; nodes.forEach(n => this.appendChild(n)); }
  /** 화면에 보이는지 (hidden 속성 또는 hidden 클래스) */
  get isShown() { return !this.hidden && !this.classList.contains('hidden'); }
}

export class FakeOption extends FakeElement {
  constructor(text = '', value = undefined, { disabled = false } = {}) {
    super('option');
    this.textContent = text;
    this._value = value;
    this.disabled = disabled;
    this.selected = false;
  }
  get value() { return this._value === undefined ? this.textContent : this._value; }
  set value(v) { this._value = String(v); }
  get label() { return this.textContent; }
}

export class FakeSelect extends FakeElement {
  constructor({ id = '', options = [] } = {}) {
    super('select', { id });
    options.forEach(o => this.appendChild(o instanceof FakeOption ? o : new FakeOption(o.label, o.value, o)));
    if (this.options.length && !this.options.some(o => o.selected)) this.options[0].selected = true;
  }
  get options() { return this.children; }
  get selectedIndex() { return this.options.findIndex(o => o.selected); }
  set selectedIndex(i) { this.options.forEach((o, k) => { o.selected = k === i; }); }
  get value() { const o = this.options.find(x => x.selected); return o ? o.value : ''; }
  set value(v) {
    const index = this.options.findIndex(o => o.value === String(v));
    this.selectedIndex = index; // 없는 값이면 -1 (선택 없음)
  }
  replaceChildren(...nodes) {
    super.replaceChildren(...nodes);
    if (this.options.length && !this.options.some(o => o.selected)) this.options[0].selected = true;
  }
  /** 사용자가 고른 것처럼: 비활성 option은 고를 수 없음 */
  async choose(value) {
    const option = this.options.find(o => o.value === value);
    if (!option || option.disabled || this.disabled) return false;
    this.value = value;
    await this.dispatchEvent({ type: 'change' });
    return true;
  }
}

export const fakeDocument = {
  createElement(tag) {
    if (tag === 'option') return new FakeOption();
    if (tag === 'select') return new FakeSelect();
    return new FakeElement(tag);
  }
};
