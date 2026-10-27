/* ============================================================
 * pages/profile.js —— 用户中心
 *
 * 对应 PHP 版 views/profile.php + api/profile.php
 *   get / update / change_password / upload_avatar / remove_avatar
 *
 * 头像上传用 FileReader 转 data URI 存库，不落任何文件
 * （纯前端没有上传目录，也避免 data.js 体积膨胀过猛）。
 * ============================================================ */

(function () {
  'use strict';

  const h = () => window.UI.html;
  const e = () => window.UI.escape;

  const AVATAR_MAX_BYTES = 200 * 1024;    // 200KB，data URI 后约 270KB
  const AVATAR_MAX_DIM = 256;             // 长边压到 256，控制体积

  async function render() {
    const me = window.Auth.currentUser();
    if (!me) throw new window.Errors.AppError('请先登录', 'E_AUTH');

    const role = await window.Repo.get('roles', me.role_id);
    const dept = me.department_id ? await window.Repo.get('departments', me.department_id) : null;
    const stats = await window.Errors.guard(() => window.LogRepo.stats(), { total: 0, streak: 0 }, 'profile:stats');
    const tasks = await window.Errors.guard(async () => {
      const all = await window.Repo.all('tasks');
      const uid = window.Auth.currentUserId();
      const mine = all.filter(t => Number(t.assignee_id) === uid);
      return {
        total: mine.length,
        done: mine.filter(t => t.status === 'completed').length,
      };
    }, { total: 0, done: 0 }, 'profile:tasks');

    const avatarUrl = me.avatar || window.OrgRepo.avatarDataUri(me.real_name || me.username);

    return h()`
      <section class="card profile">
        <div class="profile__top">
          <div class="profile__avatar">
            <img src="${e()(avatarUrl)}" id="avatarImg" alt="头像">
            <div class="profile__avatarAct">
              <button class="btn btn--sm" id="btnUploadAvatar" type="button">更换</button>
              ${me.avatar ? h()`<button class="btn btn--sm btn--ghost" id="btnRemoveAvatar" type="button">移除</button>` : ''}
            </div>
            <input type="file" id="avatarFile" accept="image/*" hidden>
          </div>
          <div class="profile__info">
            <h2>${e()(me.real_name || me.username)}</h2>
            <p class="muted">@${e()(me.username)}</p>
            <p>
              <span class="pill pill--medium">${e()(role ? role.name : '')}</span>
              ${dept ? h()`<span class="pill pill--low">${e()(dept.name)}</span>` : ''}
            </p>
            <p class="muted">加入时间：${e()((me.created_at || '').slice(0, 10) || '—')}</p>
          </div>
          <div class="profile__stats">
            <div><b>${tasks.done}</b><span>完成任务</span></div>
            <div><b>${tasks.total}</b><span>累计任务</span></div>
            <div><b>${stats.total}</b><span>日志篇数</span></div>
            <div><b>${stats.streak}</b><span>连续天数</span></div>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__h"><h3>基本资料</h3></div>
        <div class="form" id="profileForm">
          ${window.UI.field('姓名', window.UI.input('real_name', me.real_name || '', { maxlength: 64 }), {})}
          ${window.UI.field('邮箱', window.UI.input('email', me.email || '', { maxlength: 120, type: 'email' }), {})}
          ${window.UI.field('手机', window.UI.input('phone', me.phone || '', { maxlength: 11 }), {})}
          <div class="fld fld--wide">
            <button class="btn btn--primary btn--sm" id="btnSaveProfile" type="button">保存资料</button>
          </div>
        </div>
      </section>

      <section class="card">
        <div class="card__h"><h3>修改密码</h3></div>
        <div class="form" id="pwdForm">
          ${window.UI.field('当前密码', window.UI.input('old_password', '', { type: 'password', autocomplete: 'current-password' }), { wide: true })}
          ${window.UI.field('新密码', window.UI.input('new_password', '', { type: 'password', autocomplete: 'new-password', placeholder: '至少 6 位' }), {})}
          ${window.UI.field('确认新密码', window.UI.input('confirm_password', '', { type: 'password', autocomplete: 'new-password' }), {})}
          <div class="fld fld--wide">
            <button class="btn btn--primary btn--sm" id="btnChangePwd" type="button">修改密码</button>
          </div>
        </div>
        <p class="muted">修改密码后其他标签页需要重新登录。</p>
      </section>

      <section class="card">
        <div class="card__h"><h3>我的权限</h3></div>
        <div class="permgrid">
          ${window.Schema.ENUMS.permModules.map(mod => {
            const acts = window.Schema.ENUMS.permActions.filter(a => window.Auth.can(mod, a));
            return h()`
              <div class="permrow">
                <span class="permrow__m">${window.Schema.label('permModules', mod)}</span>
                <span class="permrow__a">
                  ${acts.length ? acts.map(a => h()`<em class="permtag">${window.Schema.label('permActions', a)}</em>`).join('') : '—'}
                </span>
              </div>`;
          }).join('')}
        </div>
        <p class="muted">数据范围：${window.Schema.label('dataScope', window.Auth.dataScope())}</p>
      </section>`;
  }

  /* ============================================================ */

  function bind(pageEl) {
    const me = window.Auth.currentUser();

    // 保存资料
    const save = pageEl.querySelector('#btnSaveProfile');
    if (save) {
      save.addEventListener('click', async () => {
        const form = pageEl.querySelector('#profileForm');
        const realName = window.UI.$('[name="real_name"]', form).value;
        const email = window.UI.$('[name="email"]', form).value;
        const phone = window.UI.$('[name="phone"]', form).value;

        await window.UI.withBusy(async () => {
          // 用 profileSelfSave 而不是 userSave：后者要求组织管理权限，
          // 普通成员改自己的姓名也会被权限拦下。
          const saved = await window.OrgRepo.profileSelfSave({
            real_name: realName,
            email,
            phone,
          });
          window.Auth.setUser(Object.assign({}, window.Auth.currentUser(), {
            real_name: saved.real_name, email: saved.email, phone: saved.phone,
          }), await window.Repo.get('roles', saved.role_id));
          window.UI.toast('资料已保存', 'ok');
          AppShell.nav('profile');
        }, { tag: 'profile:save' });
      });
    }

    // 修改密码
    const pwd = pageEl.querySelector('#btnChangePwd');
    if (pwd) {
      pwd.addEventListener('click', async () => {
        const form = pageEl.querySelector('#pwdForm');
        const oldPwd = window.UI.$('[name="old_password"]', form).value;
        const newPwd = window.UI.$('[name="new_password"]', form).value;
        const confirmPwd = window.UI.$('[name="confirm_password"]', form).value;

        if (!oldPwd) { window.UI.toast('请输入当前密码', 'err'); return; }
        if (newPwd.length < 6) { window.UI.toast('新密码至少 6 位', 'err'); return; }
        if (newPwd !== confirmPwd) { window.UI.toast('两次输入的新密码不一致', 'err'); return; }

        await window.UI.withBusy(async () => {
          const fresh = await window.Repo.get('users', me.id);
          let ok = false;
          try {
            ok = await window.Auth.verifyPassword(oldPwd, fresh.password);
          } catch (e) {
            window.UI.toast(e.message, 'err', { duration: 7000 });
            return;
          }
          if (!ok) { window.UI.toast('当前密码不正确', 'err'); return; }

          const hash = await window.Auth.hashPassword(newPwd);
          await window.Repo.save('users', Object.assign({}, fresh, { password: hash }));
          await window.OpLog.write('修改密码', fresh.username);
          window.UI.toast('密码已更新，请重新登录', 'ok');
          setTimeout(() => {
            window.Auth.clearSession();
            location.reload();
          }, 900);
        }, { tag: 'profile:pwd' });
      });
    }

    // 头像上传
    const fileIn = pageEl.querySelector('#avatarFile');
    const uploadBtn = pageEl.querySelector('#btnUploadAvatar');
    if (uploadBtn && fileIn) {
      uploadBtn.addEventListener('click', () => fileIn.click());
      fileIn.addEventListener('change', async () => {
        const f = fileIn.files && fileIn.files[0];
        if (!f) return;
        await handleAvatarFile(pageEl, f);
        fileIn.value = '';
      });
    }

    // 移除头像
    const rm = pageEl.querySelector('#btnRemoveAvatar');
    if (rm) {
      rm.addEventListener('click', async () => {
        const go = await window.UI.confirm('移除头像后会用姓名首字生成。确定？');
        if (!go) return;
        await window.UI.withBusy(async () => {
          const fresh = await window.Repo.get('users', me.id);
          await window.Repo.save('users', Object.assign({}, fresh, { avatar: null }));
          window.Auth.setUser(Object.assign({}, window.Auth.currentUser(), { avatar: null }),
            await window.Repo.get('roles', fresh.role_id));
          window.UI.toast('头像已移除', 'ok');
          AppShell.nav('profile');
        }, { tag: 'profile:avatar' });
      });
    }
  }

  /**
   * 处理头像文件
   *
   * 流程：校验类型/大小 → 压缩到 256px → data URI → 存库
   * 压缩很重要：手机直出照片动辄 3MB，base64 后更大，
   * 会把 data.js 撑到几十 MB，写文件时直接卡死。
   */
  async function handleAvatarFile(pageEl, file) {
    try {
      // 类型校验（不信任扩展名，看 MIME）
      if (!/^image\/(png|jpeg|jpg|gif|webp)$/i.test(file.type)) {
        throw new window.Errors.ValidationError('只支持 PNG / JPG / GIF / WebP 图片', 'avatar');
      }
      if (file.size > 8 * 1024 * 1024) {
        throw new window.Errors.ValidationError('图片不能超过 8MB', 'avatar');
      }

      const dataUri = await compressImage(file, AVATAR_MAX_DIM, AVATAR_MAX_BYTES);

      await window.UI.withBusy(async () => {
        const me = window.Auth.currentUser();
        const fresh = await window.Repo.get('users', me.id);
        await window.Repo.save('users', Object.assign({}, fresh, { avatar: dataUri }));
        window.Auth.setUser(Object.assign({}, window.Auth.currentUser(), { avatar: dataUri }),
          await window.Repo.get('roles', fresh.role_id));
        window.UI.toast('头像已更新', 'ok');
        AppShell.nav('profile');
      }, { tag: 'profile:avatar' });
    } catch (e) {
      window.UI.toast(window.Errors.normalize(e).message, 'err');
    }
  }

  /** 用 canvas 压缩图片，返回 data URI */
  function compressImage(file, maxDim, maxBytes) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new window.Errors.AppError('读取图片失败', 'E_READ'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new window.Errors.AppError('图片内容无法解析', 'E_IMG'));
        img.onload = () => {
          const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const hgt = Math.max(1, Math.round(img.height * scale));

          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = hgt;
          const ctx = canvas.getContext('2d');
          if (!ctx) { reject(new window.Errors.AppError('浏览器不支持图片处理', 'E_CANVAS')); return; }
          ctx.drawImage(img, 0, 0, w, hgt);

          // 逐级降质量直到满足体积
          let q = 0.85;
          let out = canvas.toDataURL('image/jpeg', q);
          let guard = 0;
          while (out.length * 0.75 > maxBytes && q > 0.35 && guard++ < 6) {
            q -= 0.1;
            out = canvas.toDataURL('image/jpeg', q);
          }
          resolve(out);
        };
        img.src = String(reader.result || '');
      };
      reader.readAsDataURL(file);
    });
  }

  window.Pages.profile = { render, bind };
})();
