/*
应用分组分类配置
Category configuration for app grouping
将不想显示的分类设为 `enabled: false` - 它们将被合并到"其他"中
Set `enabled: false` for categories you want to hide - they will be merged into "Other"
设置 `merge: '目标分类'` 将此分类合并到另一个分类中
Set `merge: 'TargetCategory'` to merge this category into another category
调整分类在数组中的顺序，以改变它们在网格中的显示顺序。
Change the order of categories in the array to change their display order in the grid

注意！需要重启GNOME桌面环境才能生效
Restart GNOME desktop environment to apply changes
Note: Changes to categories will not take effect until you restart GNOME desktop environment
*/ 

export const CATEGORIES = [
  // 开发工具
  {name: 'Development', enabled: true, merge: false},
  // 办公软件
  {name: 'Office', enabled: true, merge: false},
  // 网络工具
  {name: 'Network', enabled: true, merge: false},
  // 多媒体
  {name: 'AudioVideo', enabled: true, merge: false},
  // 音频
  {name: 'Audio', enabled: true, merge: 'AudioVideo'},
  // 视频
  {name: 'Video', enabled: true, merge: 'AudioVideo'},
  // 图像图形
  {name: 'Graphics', enabled: true, merge: 'AudioVideo'},
  // 教育软件
  {name: 'Education', enabled: true, merge: false},
  // 游戏
  {name: 'Game', enabled: true, merge: false},
  // 小工具
  {name: 'Utility', enabled: true, merge: false},
  // 附件
  {name: 'Accessories', enabled: true, merge: 'Utility'},
  // 系统工具
  {name: 'System', enabled: true, merge: false},
  // 系统设置
  {name: 'Settings', enabled: true, merge: 'System'},
];


/** ========== 如果你不是开发人员，不要不要修改以下内容 ========== **/
/** ========== DO NOT MODIFY THE FOLLOWING UNLESS YOU ARE A DEVELOPER ========== **/

export const CATEGORY_ORDER = CATEGORIES
  .filter(cat => cat.enabled && !cat.merge)
  .map(cat => cat.name);

export const ALL_CATEGORIES = [
  ...CATEGORIES.map(cat => cat.name),
  'Other',
];

/**
 * Get the category for an app from its desktop file categories
 */
export function getAppCategory(appInfo) {
  try {
    const categories = appInfo.get_categories();
    if (!categories)
      return 'Other';

    for (const catConfig of CATEGORIES) {
      if (categories.includes(catConfig.name)) {
        if (!catConfig.enabled) {
          return 'Other';
        }
        if (catConfig.merge) {
          return catConfig.merge;
        }
        return catConfig.name;
      }
    }

    const categoryList = categories.split(';');
    for (const cat of categoryList) {
      const trimmed = cat.trim();
      if (trimmed && ALL_CATEGORIES.includes(trimmed)) {
        const catConfig = CATEGORIES.find(c => c.name === trimmed);
        if (catConfig) {
          if (!catConfig.enabled) {
            return 'Other';
          }
          if (catConfig.merge) {
            return catConfig.merge;
          }
        }
        return trimmed;
      }
    }
  }
  catch (e) {
    console.error('Error getting app category:', e);
  }
  return 'Other';
}
