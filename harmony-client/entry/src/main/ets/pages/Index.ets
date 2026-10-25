import { cameraPicker } from '@kit.CameraKit';
import { photoAccessHelper } from '@kit.MediaLibraryKit';
import { common } from '@kit.AbilityKit';
import { promptAction } from '@kit.ArkUI';
import { AppState, Job, RecognizeItem, Spool, VisionStatus } from '../model/Types';
import {
  bulkCreate,
  consumeSpool,
  createSpool,
  deleteSpool,
  getState,
  health,
  recognize,
  visionStatus,
} from '../common/Api';
import { AppConfig, loadConfig, saveConfig } from '../common/Config';
import { uriToJpegBase64 } from '../common/ImageUtil';

const MATERIALS: string[] = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU', 'PA', 'PC', '其他'];

@Entry
@Component
struct Index {
  @State tabIndex: number = 0;
  @State busy: boolean = false;
  @State spools: Spool[] = [];
  @State jobs: Job[] = [];
  @State statusMsg: string = '';
  // 拍照/识别
  @State photoBase64: string = '';
  @State items: RecognizeItem[] = [];
  @State addMsg: string = '';
  // 手动添加
  @State manualName: string = '';
  @State manualType: string = 'PLA';
  @State manualColor: string = '#808080';
  @State manualGrams: string = '1000';
  // 设置
  @State serverUrl: string = '';
  @State token: string = '';
  @State testMsg: string = '';
  @State vision: VisionStatus | null = null;

  aboutToAppear(): void {
    this.init();
  }

  async init(): Promise<void> {
    const cfg: AppConfig = await loadConfig();
    this.serverUrl = cfg.serverUrl;
    this.token = cfg.token;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.busy = true;
    try {
      const state: AppState = await getState();
      this.spools = state.spools !== undefined ? state.spools : [];
      this.jobs = state.jobs !== undefined ? state.jobs : [];
      this.statusMsg = `已同步：${this.spools.length} 盘耗材`;
    } catch (err) {
      this.statusMsg = `连接失败：${String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  spoolImage(spool: Spool): string {
    if (spool.productPhoto !== undefined && spool.productPhoto.length > 0) {
      return spool.productPhoto;
    }
    return spool.photo !== undefined ? spool.photo : '';
  }

  photoUrl(path: string | undefined): string {
    if (path === undefined || path.length === 0) {
      return '';
    }
    if (path.startsWith('http')) {
      return path;
    }
    return `${this.serverUrl.replace(/\/+$/, '')}${path}`;
  }

  async takePhoto(): Promise<void> {
    const ctx = getContext(this) as common.UIAbilityContext;
    try {
      const res = await cameraPicker.pick(ctx, [cameraPicker.PickerMediaType.PHOTO], {
        cameraPosition: cameraPicker.CameraPosition.CAMERA_POSITION_BACK,
      });
      if (res.resultCode === 0 && res.resultUri !== undefined && res.resultUri.length > 0) {
        await this.loadPhoto(res.resultUri);
      }
    } catch (err) {
      this.addMsg = `调起相机失败：${String(err)}`;
    }
  }

  async pickPhoto(): Promise<void> {
    try {
      const picker = new photoAccessHelper.PhotoViewPicker();
      const res = await picker.select({
        MIMEType: photoAccessHelper.PhotoViewMIMETypes.IMAGE_TYPE,
        maxSelectNumber: 1,
      });
      if (res.photoUris.length > 0) {
        await this.loadPhoto(res.photoUris[0]);
      }
    } catch (err) {
      this.addMsg = `选择照片失败：${String(err)}`;
    }
  }

  async loadPhoto(uri: string): Promise<void> {
    this.busy = true;
    this.addMsg = '正在读取照片…';
    this.items = [];
    try {
      this.photoBase64 = await uriToJpegBase64(uri);
      this.addMsg = '照片已就绪，正在识别…';
      await this.runRecognize();
    } catch (err) {
      this.addMsg = `读取照片失败：${String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  async runRecognize(): Promise<void> {
    if (this.photoBase64.length === 0) {
      this.addMsg = '请先拍照或从相册选择照片';
      return;
    }
    this.busy = true;
    this.addMsg = '正在识别…';
    try {
      const result = await recognize(this.photoBase64, 'image/jpeg');
      const list: RecognizeItem[] = result.items !== undefined ? result.items : [];
      this.items = list;
      if (list.length > 0) {
        const warn: string = result.warnings !== undefined && result.warnings.length > 0 ? `（${result.warnings.join('；')}）` : '';
        this.addMsg = `识别到 ${list.length} 项${warn}`;
      } else {
        this.addMsg = result.message !== undefined ? result.message : '没有识别到耗材，可手动添加';
      }
    } catch (err) {
      this.addMsg = `识别失败：${String(err)}（可在下方手动添加）`;
    } finally {
      this.busy = false;
    }
  }

  async saveItems(): Promise<void> {
    if (this.items.length === 0) {
      return;
    }
    const payloads: Object[] = [];
    for (const item of this.items) {
      const colorHex: string = item.colorHex !== undefined && item.colorHex.length > 0 ? item.colorHex : '#808080';
      const material: string = item.material !== undefined && item.material.length > 0 ? item.material : 'PLA';
      const colorName: string = item.colorName !== undefined ? item.colorName : '';
      const grams: number = item.spoolWeightG !== undefined ? Math.round(item.spoolWeightG) : 1000;
      const count: number = item.count !== undefined ? Math.min(20, Math.max(1, Math.round(item.count))) : 1;
      const name: string = item.name !== undefined && item.name.length > 0
        ? item.name
        : `${colorName} ${material}`.trim();
      for (let i = 0; i < count; i++) {
        payloads.push({
          name: name.length > 0 ? name : `${material} 耗材`,
          brand: item.brand !== undefined ? item.brand : '',
          type: material,
          colorHex: colorHex,
          colorName: colorName,
          totalGrams: grams,
          remainingGrams: grams,
          note: item.sku !== undefined && item.sku.length > 0 ? `SKU ${item.sku}` : '',
        });
      }
    }
    this.busy = true;
    try {
      const photo: string = this.photoBase64.length > 0 ? `data:image/jpeg;base64,${this.photoBase64}` : '';
      await bulkCreate(payloads, photo);
      promptAction.showToast({ message: `已加入 ${payloads.length} 盘耗材` });
      this.items = [];
      this.photoBase64 = '';
      this.addMsg = '';
      this.tabIndex = 0;
      await this.refresh();
    } catch (err) {
      this.addMsg = `入库失败：${String(err)}`;
    } finally {
      this.busy = false;
    }
  }

  async addManual(): Promise<void> {
    const grams: number = Number(this.manualGrams);
    if (!/^#[0-9a-fA-F]{6}$/.test(this.manualColor)) {
      promptAction.showToast({ message: '颜色格式应为 #RRGGBB' });
      return;
    }
    if (!(grams > 0)) {
      promptAction.showToast({ message: '克重需要大于 0' });
      return;
    }
    this.busy = true;
    try {
      await createSpool({
        name: this.manualName.length > 0 ? this.manualName : `${this.manualType} 耗材`,
        type: this.manualType,
        colorHex: this.manualColor.toUpperCase(),
        totalGrams: grams,
        remainingGrams: grams,
      });
      this.manualName = '';
      promptAction.showToast({ message: '已添加 1 盘' });
      await this.refresh();
    } catch (err) {
      promptAction.showToast({ message: `添加失败：${String(err)}` });
    } finally {
      this.busy = false;
    }
  }

  async quickConsume(spool: Spool, grams: number): Promise<void> {
    try {
      await consumeSpool(spool.id, grams);
      await this.refresh();
      promptAction.showToast({ message: `已扣减 ${grams} g` });
    } catch (err) {
      promptAction.showToast({ message: `扣减失败：${String(err)}` });
    }
  }

  async doDelete(spool: Spool): Promise<void> {
    try {
      await deleteSpool(spool.id);
      await this.refresh();
      promptAction.showToast({ message: '已删除' });
    } catch (err) {
      promptAction.showToast({ message: `删除失败：${String(err)}` });
    }
  }

  confirmDelete(spool: Spool): void {
    AlertDialog.show({
      title: '删除耗材',
      message: `确定删除「${spool.name}」？`,
      primaryButton: { value: '取消', action: () => {} },
      secondaryButton: {
        value: '删除',
        fontColor: '#b91c1c',
        action: () => {
          this.doDelete(spool);
        },
      },
    });
  }

  async saveAndTest(): Promise<void> {
    this.testMsg = '保存中…';
    try {
      await saveConfig({ serverUrl: this.serverUrl.trim(), token: this.token.trim() });
      await health();
      const vs: VisionStatus = await visionStatus();
      this.vision = vs;
      this.testMsg = vs.ready
        ? `✅ 连接成功；识别引擎 ${vs.provider} · ${vs.model}`
        : `✅ 连接成功；识别引擎未配置（${vs.reason !== undefined ? vs.reason : ''}）`;
      await this.refresh();
    } catch (err) {
      this.testMsg = `❌ 连接失败：${String(err)}`;
    }
  }

  @Builder
  SpoolCard(spool: Spool) {
    Column() {
      Row() {
        if (this.spoolImage(spool).length > 0) {
          Image(this.photoUrl(this.spoolImage(spool)))
            .width(46)
            .height(46)
            .borderRadius(8)
            .objectFit(ImageFit.Cover)
            .backgroundColor('#eef1ef')
        } else {
          Circle().width(18).height(18).fill(spool.colorHex)
        }
        Column() {
          Text(spool.name).fontSize(16).fontWeight(FontWeight.Medium)
          Text(`${spool.brand !== undefined ? spool.brand : ''} ${spool.type}`.trim())
            .fontSize(12)
            .fontColor('#6b7773')
        }
        .alignItems(HorizontalAlign.Start)
        .layoutWeight(1)
        .margin({ left: 10 })
        Text(`${Math.round(spool.remainingGrams)} / ${Math.round(spool.totalGrams)} g`)
          .fontSize(12)
          .fontColor('#6b7773')
      }
      .width('100%')

      Row() {
        Button('-20g').fontSize(12).height(28).backgroundColor('#eef2ef').fontColor('#1c2321')
          .onClick(() => {
            this.quickConsume(spool, 20);
          })
        Button('-100g').fontSize(12).height(28).margin({ left: 6 }).backgroundColor('#eef2ef').fontColor('#1c2321')
          .onClick(() => {
            this.quickConsume(spool, 100);
          })
        Button('删除').fontSize(12).height(28).margin({ left: 6 }).backgroundColor('#fee2e2').fontColor('#b91c1c')
          .onClick(() => {
            this.confirmDelete(spool);
          })
      }
      .width('100%')
      .justifyContent(FlexAlign.End)
      .margin({ top: 8 })
    }
    .padding(12)
    .borderRadius(12)
    .backgroundColor(Color.White)
    .border({ width: 1, color: '#e3e8e5' })
  }

  @Builder
  InventoryTab() {
    Column() {
      Row() {
        Text(this.statusMsg.length > 0 ? this.statusMsg : `共 ${this.spools.length} 盘`)
          .fontSize(12)
          .fontColor('#6b7773')
          .layoutWeight(1)
        Button('刷新').fontSize(12).height(28).onClick(() => {
          this.refresh();
        })
      }
      .width('100%')
      .margin({ bottom: 8 })

      List({ space: 8 }) {
        ForEach(this.spools, (spool: Spool) => {
          ListItem() {
            this.SpoolCard(spool)
          }
        }, (spool: Spool) => spool.id)
      }
      .layoutWeight(1)
      .width('100%')
    }
    .padding(12)
    .width('100%')
    .height('100%')
  }

  @Builder
  AddTab() {
    Scroll() {
      Column() {
        Row() {
          Button('📷 拍照').onClick(() => {
            this.takePhoto();
          })
          Button('🖼️ 相册').margin({ left: 8 }).onClick(() => {
            this.pickPhoto();
          })
          Button('重新识别').margin({ left: 8 }).enabled(this.photoBase64.length > 0).onClick(() => {
            this.runRecognize();
          })
        }
        .width('100%')

        if (this.addMsg.length > 0) {
          Text(this.addMsg).fontSize(12).fontColor('#6b7773').width('100%').margin({ top: 8 })
        }
        if (this.photoBase64.length > 0) {
          Image(`data:image/jpeg;base64,${this.photoBase64}`)
            .width('100%')
            .height(200)
            .objectFit(ImageFit.Contain)
            .backgroundColor('#0b0f0e')
            .margin({ top: 8 })
        }

        ForEach(this.items, (item: RecognizeItem, index: number) => {
          Row() {
            Circle().width(16).height(16).fill(item.colorHex !== undefined ? item.colorHex : '#cccccc')
            Text(`${item.colorName !== undefined && item.colorName.length > 0 ? item.colorName : (item.name !== undefined ? item.name : '耗材')} · ${item.material !== undefined ? item.material : 'PLA'}`)
              .fontSize(14)
              .layoutWeight(1)
              .margin({ left: 8 })
            Text(`${item.spoolWeightG !== undefined ? Math.round(item.spoolWeightG) : 1000}g ×${item.count !== undefined ? item.count : 1}`)
              .fontSize(12)
              .fontColor('#6b7773')
            Button('删').fontSize(12).height(26).margin({ left: 8 }).onClick(() => {
              this.items.splice(index, 1);
              this.items = [...this.items];
            })
          }
          .width('100%')
          .padding(8)
          .margin({ top: 6 })
          .borderRadius(8)
          .backgroundColor(Color.White)
        }, (item: RecognizeItem, index: number) => `${index}-${item.sku !== undefined ? item.sku : (item.colorName !== undefined ? item.colorName : '')}`)

        Button(`全部入库（${this.items.length} 项）`)
          .width('100%')
          .margin({ top: 12 })
          .enabled(this.items.length > 0)
          .onClick(() => {
            this.saveItems();
          })

        Divider().margin({ top: 16, bottom: 12 })
        Text('手动添加一盘').fontSize(15).fontWeight(FontWeight.Medium).width('100%')

        TextInput({ placeholder: '名称，如 黑色 PLA', text: this.manualName })
          .margin({ top: 8 })
          .onChange((value: string) => {
            this.manualName = value;
          })
        TextInput({ placeholder: `材料类型：${MATERIALS.join('/')}`, text: this.manualType })
          .margin({ top: 8 })
          .onChange((value: string) => {
            this.manualType = value;
          })
        TextInput({ placeholder: '颜色 #RRGGBB', text: this.manualColor })
          .margin({ top: 8 })
          .onChange((value: string) => {
            this.manualColor = value;
          })
        TextInput({ placeholder: '克重', text: this.manualGrams })
          .type(InputType.Number)
          .margin({ top: 8 })
          .onChange((value: string) => {
            this.manualGrams = value;
          })
        Button('添加').width('100%').margin({ top: 8 }).onClick(() => {
          this.addManual();
        })
      }
      .padding(12)
      .width('100%')
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  SettingsTab() {
    Scroll() {
      Column() {
        Text('NAS 服务器地址').fontSize(13).fontColor('#6b7773').width('100%')
        TextInput({ placeholder: 'http://192.168.1.10:4174', text: this.serverUrl })
          .margin({ top: 6 })
          .onChange((value: string) => {
            this.serverUrl = value;
          })

        Text('访问令牌 FM_TOKEN（后端没设置就留空）').fontSize(13).fontColor('#6b7773').width('100%').margin({ top: 12 })
        TextInput({ placeholder: '可选', text: this.token })
          .margin({ top: 6 })
          .onChange((value: string) => {
            this.token = value;
          })

        Button('保存并测试连接').width('100%').margin({ top: 16 }).onClick(() => {
          this.saveAndTest();
        })

        if (this.testMsg.length > 0) {
          Text(this.testMsg).fontSize(12).width('100%').margin({ top: 10 })
        }

        Divider().margin({ top: 16, bottom: 12 })
        Text('说明').fontSize(14).fontWeight(FontWeight.Medium).width('100%')
        Text('· 手机上主要用来拍照/识别录入和查看库存、扣减余量。\n· 智能选料（MakerWorld 链接）等复杂操作，可用手机浏览器打开同一个地址使用完整网页版。\n· 后端在 NAS 上：docker run -d -p 4174:4174 -e FM_TOKEN=你的令牌 -v /share/filament:/app/data filament-manager')
          .fontSize(12)
          .fontColor('#6b7773')
          .width('100%')
          .margin({ top: 8 })
      }
      .padding(12)
      .width('100%')
    }
    .width('100%')
    .height('100%')
  }

  build() {
    Column() {
      Tabs({ barPosition: BarPosition.End, index: this.tabIndex }) {
        TabContent() {
          this.InventoryTab()
        }.tabBar('库存')

        TabContent() {
          this.AddTab()
        }.tabBar('添加')

        TabContent() {
          this.SettingsTab()
        }.tabBar('设置')
      }
      .onChange((index: number) => {
        this.tabIndex = index;
      })
      .barHeight(56)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#f4f6f4')
  }
}
