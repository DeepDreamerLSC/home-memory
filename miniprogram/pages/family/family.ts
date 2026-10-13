/**
 * 家庭管理页(issue #34 P1-B):浏览 + 管理一体。
 * - 单人态(status.shared=false):「个人家庭(仅自己可见)」+ 创建共享家庭入口。
 *   创建流程明示两条产品裁定文案(冻结合同决策 1/2):
 *   ①「新的共享家庭从空白开始,你现有的物品不会自动出现在里面」(需勾选确认);
 *   ②「创建后你就是这个家庭的创建者(Owner),负责邀请家人和管理成员」;
 * - 共享态:家庭名、成员列表(memberList,owner 独有——服务端 FORBIDDEN,
 *   普通成员如实不展示)、邀请(owner:inviteCreate → 微信分享卡片
 *   onShareAppMessage,path 带 invite=<token>;inviteList 列未撤销邀请可
 *   inviteRevoke)、移除成员(owner,二次确认)、退出(普通成员;owner 在有
 *   其他成员时按服务端 OWNER_NOT_LAST 如实提示)、解散(仅剩 owner 一人时
 *   呈现,二次确认 + 「数据将保留但无人可访问」说明);
 * - 切换家庭后(创建/退出/解散):作用域捕获 + 位置树缓存清空收口在
 *   households-api;页面刷新自身状态,首页/位置树经 onShow 自然重拉;
 * - 草稿:按家庭作用域键隔离(P0),退出/解散后旧草稿原地保留、回切恢复,
 *   退出确认文案如实告知不可跨域续存(F3)。
 */
import { errorMessage, formatDateTime, isApiError } from "../../utils/api";
import {
  createFamily,
  createInvite,
  dissolveFamily,
  fetchHouseholdStatus,
  fetchInviteList,
  fetchMemberList,
  leaveFamily,
  removeFamilyMember,
  revokeInvite,
} from "../../utils/households-api";
import type {
  HouseholdInviteMeta,
  HouseholdMember,
} from "../../types";

/** 用于渲染的邀请行 */
type DisplayInvite = HouseholdInviteMeta & {
  created_text: string;
  expires_text: string;
  status_text: string;
  active: boolean;
};

/** 用于渲染的成员行 */
type DisplayMember = HouseholdMember & {
  joined_text: string;
  role_text: string;
};

Page<
  {
    loading: boolean;
    loadError: string;
    /** 单人 / 共享 */
    shared: boolean;
    displayName: string;
    role: string;
    isOwner: boolean;
    members: DisplayMember[];
    /** owner 才能拉取 memberList(服务端 FORBIDDEN,普通成员如实不展示) */
    memberListAvailable: boolean;
    invites: DisplayInvite[];
    inviteListError: string;
    /** 最新一次 inviteCreate 的裸令牌(只在响应出现一次,页面内存持有,不持久化) */
    shareToken: string;
    /** 创建共享家庭的内联表单 */
    creating: boolean;
    createName: string;
    createAck: boolean;
    createBusy: boolean;
    acting: boolean;
  },
  {
    onLoad(): void;
    onShow(): void;
    onPullDownRefresh(): Promise<void>;
    refresh(): Promise<void>;
    onHomeTreeTap(): void;
    /* 创建共享家庭 */
    onStartCreateTap(): void;
    onCancelCreateTap(): void;
    onCreateNameInput(e: WechatMiniprogram.CustomEvent<{ value: string }>): void;
    onCreateAckToggle(): void;
    onCreateTap(): Promise<void>;
    /* 邀请(owner) */
    onInviteTap(): Promise<void>;
    onShareTap(): void;
    onCopyInviteTap(): void;
    onJoinByCodeTap(): void;
    onRevokeTap(e: WechatMiniprogram.CustomEvent): void;
    inviteAt(index: number): DisplayInvite | undefined;
    /* 成员(owner) */
    onRemoveMemberTap(e: WechatMiniprogram.CustomEvent): void;
    memberAt(index: number): DisplayMember | undefined;
    confirmRemoveMember(m: DisplayMember): void;
    doRemoveMember(m: DisplayMember): Promise<void>;
    /* 退出 / 解散 */
    onLeaveTap(): void;
    confirmLeave(): Promise<boolean>;
    doLeave(): Promise<void>;
    onDissolveTap(): void;
    confirmDissolve(): Promise<boolean>;
    doDissolve(): Promise<void>;
  }
>({
  data: {
    loading: false,
    loadError: "",
    shared: false,
    displayName: "",
    role: "",
    isOwner: false,
    members: [],
    memberListAvailable: false,
    invites: [],
    inviteListError: "",
    shareToken: "",
    creating: false,
    createName: "",
    createAck: false,
    createBusy: false,
    acting: false,
  },

  onLoad() {
    // 首开时 onShow 紧随 onLoad 触发,刷新统一收口在 onShow,避免双拉
  },

  onShow() {
    // 首开与从加入页/其他页面返回都刷新(轻量 status,幂等)
    void this.refresh();
  },

  async onPullDownRefresh() {
    try {
      await this.refresh();
    } finally {
      wx.stopPullDownRefresh({ fail: () => {} });
    }
  },

  /** 拉取当前家庭状态;共享态按角色补成员清单(owner)与邀请清单(owner) */
  async refresh() {
    this.setData({ loading: true, loadError: "" });
    try {
      const status = await fetchHouseholdStatus();
      if (status.shared !== true) {
        this.setData({
          shared: false,
          displayName: "",
          role: "",
          isOwner: false,
          members: [],
          memberListAvailable: false,
          invites: [],
          inviteListError: "",
          shareToken: "",
          loading: false,
        });
        return;
      }
      this.setData({
        shared: true,
        displayName: status.display_name || "我的家",
        role: status.role === "owner" ? "创建者" : "成员",
        isOwner: status.role === "owner",
        members: [],
        memberListAvailable: false,
        loading: false,
      });
      if (status.role === "owner") {
        // owner 补充成员清单与邀请清单;失败如实提示,不阻塞页面主信息
        this.setData({ memberListAvailable: true });
        try {
          const members = await fetchMemberList();
          this.setData({
            members: members.members.map((m) => ({
              ...m,
              joined_text: formatDateTime(m.joined_at),
              role_text: m.role === "owner" ? "创建者" : "成员",
            })),
          });
        } catch (e) {
          this.setData({ loadError: "成员列表加载失败:" + errorMessage(e) });
        }
        try {
          const invites = await fetchInviteList();
          this.setData({
            invites: invites
              .filter((v) => !v.revoked && !v.expired)
              .map((v) => ({
                ...v,
                created_text: formatDateTime(v.created_at),
                expires_text: formatDateTime(v.expires_at),
                status_text: "有效",
                active: true,
              })),
            inviteListError: "",
          });
        } catch (e) {
          this.setData({ inviteListError: "邀请列表加载失败:" + errorMessage(e) });
        }
      }
    } catch (e) {
      this.setData({ loading: false, loadError: errorMessage(e) });
    }
  },

  onHomeTreeTap() {
    wx.navigateTo({
      url: "/pages/locations/locations",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /* ---------------- 创建共享家庭(单人态) ---------------- */

  onStartCreateTap() {
    this.setData({ creating: true, createName: "", createAck: false });
  },

  onCancelCreateTap() {
    this.setData({ creating: false });
  },

  onCreateNameInput(e) {
    this.setData({ createName: e.detail && e.detail.value ? e.detail.value : "" });
  },

  onCreateAckToggle() {
    this.setData({ createAck: !this.data.createAck });
  },

  /** 创建空白共享家庭:勾选「从空白开始」确认是硬前置(决策 1 明示) */
  async onCreateTap() {
    if (this.data.createBusy) {
      return;
    }
    if (!this.data.createAck) {
      wx.showToast({ title: "请先勾选确认「从空白开始」", icon: "none" });
      return;
    }
    const name = this.data.createName.trim();
    if (name.length > 30) {
      wx.showToast({ title: "家庭名最多 30 个字", icon: "none" });
      return;
    }
    this.setData({ createBusy: true });
    try {
      await createFamily(name.length > 0 ? name : undefined);
      this.setData({ creating: false, createName: "", createAck: false });
      wx.showToast({ title: "共享家庭已创建", icon: "success" });
      await this.refresh();
    } catch (e) {
      wx.showModal({ title: "创建失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ createBusy: false });
    }
  },

  /* ---------------- 邀请家人(owner) ---------------- */

  /** 生成邀请令牌:裸令牌只在响应出现一次,存页面内存供分享卡片使用 */
  async onInviteTap() {
    if (this.data.acting) {
      return;
    }
    this.setData({ acting: true });
    try {
      const invite = await createInvite();
      this.setData({ shareToken: invite.token });
      wx.showToast({
        title: "邀请已生成,点「分享给家人」发送",
        icon: "none",
        duration: 2500,
      });
      try {
        const invites = await fetchInviteList();
        this.setData({
          invites: invites
            .filter((v) => !v.revoked && !v.expired)
            .map((v) => ({
              ...v,
              created_text: formatDateTime(v.created_at),
              expires_text: formatDateTime(v.expires_at),
              status_text: "有效",
              active: true,
            })),
        });
      } catch (e) {
        this.setData({ inviteListError: "邀请列表加载失败:" + errorMessage(e) });
      }
    } catch (e) {
      wx.showModal({ title: "生成邀请失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 分享卡片按钮(open-type=share 触发 onShareAppMessage) */
  onShareTap() {
    // 实际分享内容由 onShareAppMessage 提供;此处仅作显式入口
  },

  /** 复制邀请码(体验版兜底:分享卡片受限时,家人手动输入令牌加入) */
  onCopyInviteTap() {
    const token = this.data.shareToken;
    if (!token) {
      return;
    }
    wx.setClipboardData({
      data: token,
      success: () => {
        wx.showToast({ title: "邀请码已复制,发给家人即可", icon: "none", duration: 2500 });
      },
    });
  },

  /** 单人态「收到邀请码」入口:进入加入页手输阶段 */
  onJoinByCodeTap() {
    wx.navigateTo({
      url: "/pages/join-family/join-family",
      fail: () => {
        wx.showToast({ title: "页面打开失败,请重试", icon: "none" });
      },
    });
  },

  /**
   * 微信分享卡片:仅携带邀请令牌(门票),落地页为加入确认页(一步确认,
   * 不静默加入)。未生成令牌时分享首页(不给无效卡片)。
   */
  onShareAppMessage(): WechatMiniprogram.Page.ICustomShareContent {
    const token = this.data.shareToken;
    if (token) {
      return {
        title: "邀请你加入家庭「" + (this.data.displayName || "我的家") + "」",
        path: "/pages/join-family/join-family?invite=" + encodeURIComponent(token),
      };
    }
    return {
      title: "我靠东西呢——东西放哪儿了?我记得。",
      path: "/pages/index/index",
    };
  },

  inviteAt(index) {
    const invite = this.data.invites[index];
    return invite ? invite : undefined;
  },

  /** 撤销邀请:二次确认后 inviteRevoke(立即失效);清掉页面持有的分享令牌 */
  onRevokeTap(e) {
    const index = Number(e.currentTarget.dataset.index);
    const invite = this.inviteAt(index);
    if (!invite) {
      return;
    }
    wx.showModal({
      title: "撤销邀请",
      content: "撤销后这个邀请卡片立即失效,拿到卡片的人不能再凭它加入。继续?",
      confirmText: "撤销",
      cancelText: "返回",
      success: (r) => {
        if (r.confirm) {
          void (async () => {
            try {
              await revokeInvite(invite.invite_id);
              // 令牌与 invite_id 不对应(清单不回令牌),保守整体作废:
              // 持有的分享令牌可能就是被撤销的这枚,宁可重新生成
              this.setData({ shareToken: "" });
              wx.showToast({ title: "已撤销", icon: "success" });
              const invites = await fetchInviteList();
              this.setData({
                invites: invites
                  .filter((v) => !v.revoked && !v.expired)
                  .map((v) => ({
                    ...v,
                    created_text: formatDateTime(v.created_at),
                    expires_text: formatDateTime(v.expires_at),
                    status_text: "有效",
                    active: true,
                  })),
              });
            } catch (err) {
              wx.showModal({
                title: "撤销失败",
                content: errorMessage(err),
                showCancel: false,
              });
            }
          })();
        }
      },
    });
  },

  /* ---------------- 移除成员(owner) ---------------- */

  memberAt(index) {
    const member = this.data.members[index];
    return member ? member : undefined;
  },

  onRemoveMemberTap(e) {
    if (this.data.acting) {
      return;
    }
    const index = Number(e.currentTarget.dataset.index);
    const member = this.memberAt(index);
    if (!member || member.is_self) {
      return;
    }
    this.confirmRemoveMember(member);
  },

  /** 移除成员二次确认:讲清「移除≠删数据」与对方立即失去访问 */
  confirmRemoveMember(member) {
    wx.showModal({
      title: "移除成员",
      content:
        "移除后,对方立即看不到这个家庭的物品与位置,回到自己的个人家庭;" +
        "对方记录过的数据会原样保留,不会被删除。继续?",
      confirmText: "移除",
      confirmColor: "#d93025",
      cancelText: "取消",
      success: (r) => {
        if (r.confirm) {
          void this.doRemoveMember(member);
        }
      },
    });
  },

  async doRemoveMember(member) {
    this.setData({ acting: true });
    try {
      await removeFamilyMember(member.member_key);
      wx.showToast({ title: "已移除", icon: "success" });
      await this.refresh();
    } catch (e) {
      wx.showModal({ title: "移除失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },

  /* ---------------- 退出 / 解散 ---------------- */

  /** 退出家庭:普通成员;owner 由服务端按成员数裁定(OWNER_NOT_LAST/OWNER_MUST_DISSOLVE 如实提示) */
  onLeaveTap() {
    if (this.data.acting) {
      return;
    }
    void this.confirmLeave().then((ok) => {
      if (ok) {
        void this.doLeave();
      }
    });
  },

  /** 退出确认:讲清草稿按家庭隔离、不可跨域续存(F3)与数据零触碰 */
  confirmLeave(): Promise<boolean> {
    return new Promise((resolve) => {
      wx.showModal({
        title: "退出共享家庭?",
        content:
          "退出后你回到自己的个人家庭(数据完好);这个家庭的物品你将不再可见。" +
          "在这个家庭里没记完的草稿会留在这里,回到个人家庭后看不到;再次加入才能找回。" +
          "继续?",
        confirmText: "退出",
        confirmColor: "#d93025",
        cancelText: "取消",
        success: (r) => {
          resolve(r.confirm === true);
        },
        fail: () => {
          resolve(false);
        },
      });
    });
  },

  async doLeave() {
    this.setData({ acting: true });
    try {
      await leaveFamily();
      wx.showToast({ title: "已回到个人家庭", icon: "success" });
      await this.refresh();
    } catch (e) {
      // OWNER_NOT_LAST / OWNER_MUST_DISSOLVE 等服务端裁定如实提示
      if (isApiError(e)) {
        wx.showModal({ title: "无法退出", content: e.message, showCancel: false });
      } else {
        wx.showModal({ title: "退出失败", content: errorMessage(e), showCancel: false });
      }
    } finally {
      this.setData({ acting: false });
    }
  },

  /** 解散家庭:仅剩 owner 一人时呈现(owner 由成员清单判定;服务端为最终权威) */
  onDissolveTap() {
    if (this.data.acting) {
      return;
    }
    void this.confirmDissolve().then((ok) => {
      if (ok) {
        void this.doDissolve();
      }
    });
  },

  /** 解散二次确认:第一次讲清语义,第二次明确执行 */
  confirmDissolve(): Promise<boolean> {
    return new Promise((resolve) => {
      wx.showModal({
        title: "解散家庭",
        content:
          "解散后,这个家庭的数据将保留但无人可访问(包括你);全部邀请立即作废。" +
          "这是不可恢复的操作(数据不会删除,但家庭无法重新打开)。继续?",
        confirmText: "继续",
        confirmColor: "#d93025",
        cancelText: "取消",
        success: (r) => {
          if (r.confirm !== true) {
            resolve(false);
            return;
          }
          wx.showModal({
            title: "确认解散?",
            content: "再次确认:家庭将封存,任何人都不能再进入。确定解散?",
            confirmText: "解散",
            confirmColor: "#d93025",
            cancelText: "取消",
            success: (r2) => {
              resolve(r2.confirm === true);
            },
            fail: () => {
              resolve(false);
            },
          });
        },
        fail: () => {
          resolve(false);
        },
      });
    });
  },

  async doDissolve() {
    this.setData({ acting: true });
    try {
      await dissolveFamily();
      wx.showToast({ title: "家庭已解散", icon: "success" });
      await this.refresh();
    } catch (e) {
      wx.showModal({ title: "解散失败", content: errorMessage(e), showCancel: false });
    } finally {
      this.setData({ acting: false });
    }
  },
});
