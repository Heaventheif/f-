"use strict";
// تجميع أوامر الإدارة في وحدة واحدة مع الحفاظ على إعدادات الصلاحيات الأصلية لكل أمر.
import group from "./_modules/group.js";
import user from "./_modules/user.js";
import ban from "./_modules/ban.js";

export const commands = [group, user, ban];
