import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import type { AuthContext } from './auth-context';
import {
  isSupabaseSocialAuthProvider,
  type SupabaseSocialAuthProvider,
} from './social-auth.providers';

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  async authenticate(
    accessToken: string,
    workspaceId?: string,
  ): Promise<AuthContext> {
    const supabaseUser =
      await this.supabase.getUserFromAccessToken(accessToken);
    if (!supabaseUser?.email) {
      throw new UnauthorizedException('Invalid or expired access token.');
    }

    const user = await this.findOrLinkUser(supabaseUser.id, supabaseUser.email);
    const memberships = await this.prisma.db.membership.findMany({
      where: { userId: user.id },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      throw new ForbiddenException('You do not belong to a workspace.');
    }

    const targetWorkspaceId = workspaceId ?? user.currentWorkspaceId;
    const membership = targetWorkspaceId
      ? memberships.find((item) => item.workspaceId === targetWorkspaceId)
      : memberships[0];

    if (!membership) {
      throw new ForbiddenException('Workspace was not found for this account.');
    }

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        supabaseAuthId: user.supabaseAuthId,
      },
      workspace: {
        id: membership.workspace.id,
        name: membership.workspace.name,
        slug: membership.workspace.slug,
        role: membership.role,
      },
    };
  }

  async login(email: string, password: string) {
    const session = await this.supabase.signInWithPassword(email, password);
    if (!session?.access_token || !session.user.email) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.toSessionResponse(
      session.access_token,
      session.expires_in,
      session.user.email,
      session.user.id,
    );
  }

  async startSocialOAuth(providerName: string) {
    if (!isSupabaseSocialAuthProvider(providerName)) {
      throw new BadRequestException(
        'Unsupported social provider. Use google or facebook.',
      );
    }

    const provider: SupabaseSocialAuthProvider = providerName;
    const { url, redirectTo } =
      await this.supabase.getOAuthSignInUrl(provider);

    return {
      provider,
      url,
      redirectTo,
    };
  }

  /**
   * After the frontend finishes the Supabase OAuth redirect and has an access token,
   * exchange it for the API session payload (same shape as password login).
   */
  async completeSocialLogin(accessToken: string) {
    const supabaseUser =
      await this.supabase.getUserFromAccessToken(accessToken);
    if (!supabaseUser?.email) {
      throw new UnauthorizedException('Invalid or expired access token.');
    }

    // Ensure the Supabase identity is linked to a workspace-backed app user.
    await this.findOrLinkUser(supabaseUser.id, supabaseUser.email);

    return this.toSessionResponse(
      accessToken,
      null,
      supabaseUser.email,
      supabaseUser.id,
    );
  }

  getSocialAuthHealth() {
    return this.supabase.checkSocialAuth();
  }

  private toSessionResponse(
    accessToken: string,
    expiresIn: number | null,
    email: string,
    supabaseAuthId: string,
  ) {
    return {
      accessToken,
      tokenType: 'Bearer' as const,
      expiresIn,
      user: {
        email,
        supabaseAuthId,
      },
    };
  }

  private async findOrLinkUser(supabaseAuthId: string, email: string) {
    const byAuthId = await this.prisma.db.user.findUnique({
      where: { supabaseAuthId },
    });
    if (byAuthId) {
      return byAuthId;
    }

    const byEmail = await this.prisma.db.user.findUnique({
      where: { email },
    });
    if (!byEmail) {
      throw new UnauthorizedException('No account is linked to this sign-in.');
    }

    // Re-bind when Auth user was recreated or a test left a stale supabaseAuthId.
    if (byEmail.supabaseAuthId === supabaseAuthId) {
      return byEmail;
    }

    return this.prisma.db.user.update({
      where: { id: byEmail.id },
      data: { supabaseAuthId },
    });
  }
}
