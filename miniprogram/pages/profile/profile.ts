import { getUserProfile, saveUserProfile } from "../../utils/profile-api";
import { applyPageAppearance } from "../../utils/appearance-page";
Page({
  data: { nickname:"", avatarFileId:"", avatarPath:"", initial:"", version:0, loading:true, ready:false, saving:false, error:"", dirty:false },
  active: false,
  unloaded: false,
  savedWhileHidden: false,
  onShow() { this.active=true; applyPageAppearance(this); if(this.savedWhileHidden){this.savedWhileHidden=false;wx.showToast({title:"资料已保存",icon:"success"});wx.navigateBack();return;} if (!this.data.dirty && !this.data.saving) void this.loadProfile(); },
  onHide() { this.active=false; },
  onUnload() { this.active=false;this.unloaded=true; },
  async loadProfile() {
    this.setData({loading:true,error:""});
    try { const p=await getUserProfile(); if(this.active && !this.data.dirty) this.setData({...p,initial:Array.from(p.nickname)[0]||"",loading:false,ready:true}); }
    catch(e) { if(this.active) this.setData({loading:false,error:(e as Error).message}); }
  },
  onNicknameInput(e:WechatMiniprogram.CustomEvent<{value:string}>) { if(this.data.saving)return; const nickname=e.detail.value;this.setData({nickname,initial:Array.from(nickname.trim())[0]||"",dirty:true}); },
  onChooseAvatar(e:WechatMiniprogram.CustomEvent<{avatarUrl:string}>) { if(this.data.saving)return; if(e.detail.avatarUrl)this.setData({avatarPath:e.detail.avatarUrl,dirty:true,error:""}); },
  async onSaveTap() {
    if(!this.data.ready||this.data.loading||this.data.saving)return;
    const nickname=this.data.nickname.trim();
    if(!nickname||Array.from(nickname).length>20||/[\u0000-\u001f\u007f]/.test(nickname)){this.setData({error:"请填写1–20个字的昵称"});return;}
    this.setData({saving:true,error:""});
    try { const p=await saveUserProfile({nickname,avatarPath:this.data.avatarPath||undefined,version:this.data.version}); if(!this.unloaded){this.setData({...p,avatarPath:"",saving:false,dirty:false}); if(this.active){wx.showToast({title:"资料已保存",icon:"success"});wx.navigateBack();}else this.savedWhileHidden=true;} }
    catch(e) { if(!this.unloaded)this.setData({saving:false,error:(e as Error).message}); }
  },
  onRetryTap() { void this.loadProfile(); }
});
